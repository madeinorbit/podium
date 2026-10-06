import { normalizeOriginUrl } from '@podium/model/browser'
import { compareStructural, computed, observable } from 'mobx'
import type { HeaderRows } from './header-schema'
import { createKeyedAnswer, type KeyedAnswer } from './query-result'

type Identity = {
  path: string
  group: string
  links: readonly string[]
  arrival: number
  machineId: string | undefined
  repoId: string | undefined
}
type Scope = {
  order: number
  memberOrder: number
  repositoryId: string
  repoId: string | null
  repoPath: string
}
type RankedId = { id: string; rank: number }
const scopeOrder = (a: Scope, b: Scope) => a.order - b.order || a.memberOrder - b.memberOrder
const scopeKey = (path: string, machineId?: string) =>
  JSON.stringify([path, 'machine', machineId ?? null])
const anyScopeKey = (path: string) => JSON.stringify([path, 'any'])
const EMPTY: readonly string[] = []

/** Identity relations in the existing header owner. Payloads stay in its
 * table; queries address one path and its canonical repository group. */
export function createHeaderRepositoryRelations() {
  const facts = observable.map<string, Identity>(undefined, { deep: false })
  const paths = observable.map<string, KeyedAnswer<RankedId>>(undefined, { deep: false })
  const groups = observable.map<string, KeyedAnswer<RankedId>>(undefined, { deep: false })
  const roots = observable.map<string, readonly RankedId[]>(undefined, { deep: false })
  const rootIds = computed(() => [...roots.values()].flat()
    .sort((a, b) => a.rank - b.rank).map(value => value.id), { equals: compareStructural })
  const groupIds = computed(() => [...roots.entries()]
    .sort((a, b) => a[1][0]!.rank - b[1][0]!.rank).map(([id]) => id),
    { equals: compareStructural })
  const linked = observable.map<string, number>(undefined, { deep: false })
  const scopeAnswers = new Map<string, KeyedAnswer<Scope>>()
  const firstScopes = observable.map<string, Scope>(undefined, { deep: false })
  const scopeMembers = new Map<string, { key: string; id: string }[]>()
  const dirtyScopes = new Set<string>()
  let positions: Map<string, number> | undefined
  let arrival = 0
  const rank = (id: string) => positions?.get(id) ?? facts.get(id)!.arrival
  const active = (id: string) => !positions || positions.has(id)
  const eligible = (group: string) =>
    (groups.get(group)?.snapshot() ?? []).flatMap(({ id }) =>
      linked.has(facts.get(id)!.path) ? [] : [id],
    )
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
      const ids = eligible(group),
        first = ids[0]
      if (first === undefined) {
        roots.delete(group)
        scopeMembers.delete(group)
        continue
      }
      // Launch choices draw root checkouts, never the standalone scan rows
      // for their linked worktrees. Maintain that membership with this group.
      const nextRoots = ids.map(id => ({ id, rank: rank(id) }))
      if (!compareStructural(roots.get(group), nextRoots)) roots.set(group, nextRoots)
      const repoId = ids.map((id) => facts.get(id)!.repoId).find((id) => id !== undefined) ?? null
      const order = rank(first),
        members: { key: string; id: string }[] = []
      for (const id of ids) {
        const fact = facts.get(id)!
        const value = {
          order,
          memberOrder: rank(id),
          repositoryId: id,
          repoId: repoId ?? fact.repoId ?? null,
          repoPath: fact.path,
        }
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
    const previous = table.get(key),
      before = previous?.get(id)
    const at = present ? rank(id) : undefined
    if (before?.rank === at) return
    const next = previous?.fork() ?? createKeyedAnswer<RankedId>((a, b) => a.rank - b.rank)
    if (present) next.set(id, id, { id, rank: at! })
    else next.delete(id)
    if (next.first()) table.set(key, next)
    else table.delete(key)
  }
  function contribute(id: string, fact: Identity, delta: 1 | -1) {
    dirtyScopes.add(fact.group)
    member(paths, fact.path, id, delta === 1)
    member(groups, fact.group, id, delta === 1)
    for (const path of fact.links) {
      const before = linked.get(path) ?? 0,
        count = before + delta
      if (count) linked.set(path, count)
      else linked.delete(path)
      if (!!before !== !!count)
        for (const member of paths.get(path)?.snapshot() ?? [])
          dirtyScopes.add(facts.get(member.id)!.group)
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
      for (const id of changed) {
        const fact = facts.get(id)
        if (!fact) continue
        const before = !previous || previous.has(id),
          after = next.has(id)
        if (before !== after) contribute(id, fact, after ? 1 : -1)
        if (before && after && (previous?.get(id) ?? fact.arrival) !== next.get(id)) {
          member(paths, fact.path, id, true)
          member(groups, fact.group, id, true)
          dirtyScopes.add(fact.group)
        }
      }
      flush()
    },
    group(path: string): readonly string[] {
      if (linked.has(path)) return EMPTY
      const visited = new Set<string>()
      for (const { id } of paths.get(path)?.snapshot() ?? []) {
        const key = facts.get(id)!.group
        if (visited.has(key)) continue
        visited.add(key)
        const ids = eligible(key)
        if (ids.length && facts.get(ids[0]!)!.path === path) return ids
      }
      return EMPTY
    },
    rootIds: () => rootIds.get(),
    groupIds: () => groupIds.get(),
    groupRoots: (id: string) => roots.get(id)?.map(root => root.id) ?? EMPTY,
    flush,
    shippingScope(
      cwd: string,
      machineId?: string,
    ): { order: number; repoId: string | null; repoPath: string; handoff: { repositoryId: string; repoPath: string; worktreePath: string } | undefined } | undefined {
      let first: Scope | undefined,
        matchedLength = -1,
        handoff: Scope | undefined,
        handoffPath = ''
      const take = (path: string) => {
        const exact = firstScopes.get(machineId ? scopeKey(path, machineId) : anyScopeKey(path))
        const wildcard = machineId ? firstScopes.get(scopeKey(path)) : undefined
        for (const candidate of [exact, wildcard]) {
          if (!candidate) continue
          // Handoff uses the longest containing worktree across repositories;
          // shipping retains its existing first-group precedence. Both read
          // the same maintained slots, including headless senders. A known
          // sender machine needs an exact peer; shipping still accepts wildcard facts.
          if (candidate === exact && (!handoff || path.length > handoffPath.length ||
            (path.length === handoffPath.length && scopeOrder(candidate, handoff) < 0))) {
            handoff = candidate
            handoffPath = path
          }
          // First repository group wins; within it the longest containing
          // worktree wins, with stable source order breaking path ties.
          if (
            !first ||
            candidate.order < first.order ||
            (candidate.order === first.order &&
              (path.length > matchedLength ||
                (path.length === matchedLength && candidate.memberOrder < first.memberOrder)))
          ) {
            first = candidate
            matchedLength = path.length
          }
        }
      }
      take(cwd)
      for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1)) {
        take(cwd.slice(0, at))
        take(cwd.slice(0, at + 1))
      }
      return first && { order: first.order, repoId: first.repoId, repoPath: first.repoPath,
        handoff: handoff ? { repositoryId: handoff.repositoryId, repoPath: handoff.repoPath, worktreePath: handoffPath } : undefined }
    },
    clear() {
      facts.clear()
      paths.clear()
      groups.clear()
      roots.clear()
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
