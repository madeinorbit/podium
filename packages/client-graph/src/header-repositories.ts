import { normalizeOriginUrl } from '@podium/model/browser'
import { compareStructural, observable } from 'mobx'
import type { HeaderRows } from './header-schema'

type Identity = { path: string; group: string; links: readonly string[]; arrival: number }
const EMPTY: readonly string[] = []

/** Identity relations in the existing header owner. Payloads stay in its
 * table; queries address one path and its canonical repository group. */
export function createHeaderRepositoryRelations() {
  const facts = observable.map<string, Identity>(undefined, { deep: false })
  const paths = observable.map<string, readonly string[]>(undefined, { deep: false })
  const groups = observable.map<string, readonly string[]>(undefined, { deep: false })
  const linked = observable.map<string, number>(undefined, { deep: false })
  let positions: Map<string, number> | undefined
  let arrival = 0
  const rank = (id: string) => positions?.get(id) ?? facts.get(id)!.arrival
  const ordered = (ids: readonly string[]) => [...ids].sort((a, b) => rank(a) - rank(b))
  const active = (id: string) => !positions || positions.has(id)
  function member(table: typeof paths, key: string, id: string, present: boolean) {
    const previous = table.get(key) ?? EMPTY
    const next = present ? ordered([...previous, id]) : previous.filter((value) => value !== id)
    if (next.length) table.set(key, next)
    else table.delete(key)
  }
  function contribute(id: string, fact: Identity, delta: 1 | -1) {
    member(paths, fact.path, id, delta === 1)
    member(groups, fact.group, id, delta === 1)
    for (const path of fact.links) {
      const count = (linked.get(path) ?? 0) + delta
      if (count) linked.set(path, count)
      else linked.delete(path)
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
    },
    group(path: string): readonly string[] {
      if (linked.has(path)) return EMPTY
      const visited = new Set<string>()
      for (const id of paths.get(path) ?? EMPTY) {
        const key = facts.get(id)!.group
        if (visited.has(key)) continue
        visited.add(key)
        const ids = (groups.get(key) ?? EMPTY).filter(
          (candidate) => !linked.has(facts.get(candidate)!.path),
        )
        if (ids.length && facts.get(ids[0]!)!.path === path) return ids
      }
      return EMPTY
    },
    clear() {
      facts.clear()
      paths.clear()
      groups.clear()
      linked.clear()
      positions = undefined
      arrival = 0
    },
  }
}
