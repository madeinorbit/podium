import { normalizeOriginUrl } from '@podium/model/browser'
import { compareStructural, observable } from 'mobx'
import type { HeaderRows } from './header-schema'
import { createKeyedAnswer, type KeyedAnswer } from './query-result'

type Identity = {
  path: string; group: string; links: readonly string[]; arrival: number
  machineId: string | undefined; repoId: string | undefined
}
type Scope = { order: number; memberOrder: number; repoId: string | null }
const scopeOrder = (a: Scope, b: Scope) => a.order - b.order || a.memberOrder - b.memberOrder
const scopeKey = (path: string, machineId?: string) => JSON.stringify([path, 'machine', machineId ?? null])
const anyScopeKey = (path: string) => JSON.stringify([path, 'any'])
const EMPTY: readonly string[] = []

/** Identity relations in the existing header owner. Payloads stay in its
 * table; queries address one path and its canonical repository group. */
export function createHeaderRepositoryRelations() {
  const facts = observable.map<string, Identity>(undefined, { deep: false })
  const paths = observable.map<string, readonly string[]>(undefined, { deep: false })
  const groups = observable.map<string, readonly string[]>(undefined, { deep: false })
  const linked = observable.map<string, number>(undefined, { deep: false })
  const scopeAnswers = new Map<string, KeyedAnswer<Scope>>()
  const firstScopes = observable.map<string, Scope>(undefined, { deep: false })
  const scopeMembers = new Map<string, { key: string; id: string }[]>()
  const dirtyScopes = new Set<string>()
  let positions: Map<string, number> | undefined
  let arrival = 0
  const rank = (id: string) => positions?.get(id) ?? facts.get(id)!.arrival
  const ordered = (ids: readonly string[]) => [...ids].sort((a, b) => rank(a) - rank(b))
  const active = (id: string) => !positions || positions.has(id)
  const eligible = (group: string) => (groups.get(group) ?? EMPTY).filter(id => !linked.has(facts.get(id)!.path))
  function scopeMember(key: string, id: string, value?: Scope) {
    let answer = scopeAnswers.get(key)
    if (!answer) {
      if (!value) return
      answer = createKeyedAnswer(scopeOrder)
      scopeAnswers.set(key, answer)
    }
    if (value) answer.set(id, id, value)
    else answer.delete(id)
    const first = answer.first()
    if (first) {
      if (!compareStructural(firstScopes.get(key), first)) firstScopes.set(key, first)
    } else {
      firstScopes.delete(key)
      scopeAnswers.delete(key)
    }
  }
  function flush() {
    // A source batch may change several clones of the same repository. Refile
    // that named group's lane relations once, after all its facts are current.
    for (const group of dirtyScopes) {
      for (const member of scopeMembers.get(group) ?? []) scopeMember(member.key, member.id)
      const ids = eligible(group), first = ids[0]
      if (first === undefined) { scopeMembers.delete(group); continue }
      const repoId = ids.map(id => facts.get(id)!.repoId).find(id => id !== undefined) ?? null
      const order = rank(first), members: { key: string; id: string }[] = []
      for (const id of ids) {
        const fact = facts.get(id)!
        const value = { order, memberOrder: rank(id), repoId: repoId ?? fact.repoId ?? null }
        for (const path of new Set([fact.path, ...fact.links])) {
          const memberId = JSON.stringify([id, path])
          for (const key of [anyScopeKey(path), scopeKey(path, fact.machineId)]) {
            scopeMember(key, memberId, value)
            members.push({ key, id: memberId })
          }
        }
      }
      scopeMembers.set(group, members)
    }
    dirtyScopes.clear()
  }
  function member(table: typeof paths, key: string, id: string, present: boolean) {
    const previous = table.get(key) ?? EMPTY
    const next = present ? ordered([...previous, id]) : previous.filter((value) => value !== id)
    if (next.length) table.set(key, next)
    else table.delete(key)
  }
  function contribute(id: string, fact: Identity, delta: 1 | -1) {
    dirtyScopes.add(fact.group)
    member(paths, fact.path, id, delta === 1)
    member(groups, fact.group, id, delta === 1)
    for (const path of fact.links) {
      const before = linked.get(path) ?? 0, count = before + delta
      if (count) linked.set(path, count)
      else linked.delete(path)
      if (!!before !== !!count)
        for (const member of paths.get(path) ?? EMPTY) dirtyScopes.add(facts.get(member)!.group)
    }
  }
  return {
    set(id: string, row: HeaderRows['repository'] | undefined) {
      const previous = facts.get(id)
      const next: Identity | undefined = row && {
        path: row.path,
        group:
          row.repoId ??
          (normalizeOriginUrl(row.originUrl) || `local:${row.machineId ?? ''}:${row.path}`),
        links: row.worktrees.map((tree) => tree.path),
        arrival: previous?.arrival ?? arrival++,
        machineId: row.machineId || undefined,
        repoId: row.repoId,
      }
      if (compareStructural(previous, next)) return
      if (previous && active(id)) contribute(id, previous, -1)
      if (next) {
        facts.set(id, next)
        if (active(id)) contribute(id, next, 1)
      } else facts.delete(id)
    },
    order(ids: readonly string[]) {
      // An order publication names the complete changed source order. It is
      // consumed here once; point questions never observe that whole order.
      const next = new Map(ids.map((id, at) => [id, at]))
      const previous = positions
      const changed = new Set(previous ? [...previous.keys(), ...ids] : [...facts.keys(), ...ids])
      positions = next
      const reorderPaths = new Set<string>(),
        reorderGroups = new Set<string>()
      for (const id of changed) {
        const fact = facts.get(id)
        if (!fact) continue
        const before = !previous || previous.has(id),
          after = next.has(id)
        if (before !== after) contribute(id, fact, after ? 1 : -1)
        if (before && after && (previous?.get(id) ?? fact.arrival) !== next.get(id)) {
          reorderPaths.add(fact.path)
          reorderGroups.add(fact.group)
          dirtyScopes.add(fact.group)
        }
      }
      for (const key of reorderPaths) {
        const before = paths.get(key)!
        const after = ordered(before)
        if (!compareStructural(before, after)) paths.set(key, after)
      }
      for (const key of reorderGroups) {
        const before = groups.get(key)!
        const after = ordered(before)
        if (!compareStructural(before, after)) groups.set(key, after)
      }
      flush()
    },
    group(path: string): readonly string[] {
      if (linked.has(path)) return EMPTY
      const visited = new Set<string>()
      for (const id of paths.get(path) ?? EMPTY) {
        const key = facts.get(id)!.group
        if (visited.has(key)) continue
        visited.add(key)
        const ids = eligible(key)
        if (ids.length && facts.get(ids[0]!)!.path === path) return ids
      }
      return EMPTY
    },
    flush,
    shippingScope(cwd: string, machineId?: string): { order: number; repoId: string | null } | undefined {
      let first: Scope | undefined
      const take = (path: string) => {
        const exact = firstScopes.get(machineId ? scopeKey(path, machineId) : anyScopeKey(path))
        const wildcard = machineId ? firstScopes.get(scopeKey(path)) : undefined
        for (const candidate of [exact, wildcard])
          if (candidate && (!first || scopeOrder(candidate, first) < 0)) first = candidate
      }
      take(cwd)
      for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1)) {
        take(cwd.slice(0, at))
        take(cwd.slice(0, at + 1))
      }
      return first && { order: first.order, repoId: first.repoId }
    },
    clear() {
      facts.clear()
      paths.clear()
      groups.clear()
      linked.clear()
      positions = undefined
      arrival = 0
      scopeAnswers.clear()
      firstScopes.clear()
      scopeMembers.clear()
      dirtyScopes.clear()
    },
  }
}
