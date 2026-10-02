import { compareStructural, computed, reaction, type IComputedValue } from 'mobx'
import type { MobxPool } from './pool'
import { MISSION_SCHEMA } from './mission-schema'
import { LOADING, type Loaded } from './worklist/rollup'

interface RootFacts {
  readonly parentId: string | null
  readonly hidden: boolean
}

/** A mission member set has no ordering contract. Consumers needing issue or
 * session order keep their own presentation order, as legacy navigation does.
 * Values contain IDs only and live with this principal's pool. */
export interface MissionViews {
  rootFor(id: string | null): Loaded<string>
  members(rootId: string): ReadonlySet<string> | typeof LOADING
  contains(rootId: string, issueId: string): boolean | typeof LOADING
  /** Store-level work counters, used by the diagnostic and invalidation tests. */
  readonly stats: { roots: number; members: number }
  dispose(): void
}

function equalMembers(a: ReadonlySet<string> | typeof LOADING, b: ReadonlySet<string> | typeof LOADING): boolean {
  return a === b || (a !== LOADING && b !== LOADING && a.size === b.size && [...a].every(id => b.has(id)))
}

export function createMissionViews(pool: MobxPool): MissionViews {
  const roots = new Map<string, IComputedValue<Loaded<string>>>()
  const members = new Map<string, IComputedValue<ReadonlySet<string> | typeof LOADING>>()
  const facts = new Map<string, IComputedValue<Loaded<RootFacts>>>()
  const stops: Array<() => void> = []
  const stats = { roots: 0, members: 0 }
  let disposed = false

  // A gesture has no observer. Retain its computed so the next gesture shares
  // the same value; dependency tracking invalidates only affected roots. The
  // pool registry releases every subscription on teardown/principal change.
  function memo<T>(cache: Map<string, IComputedValue<T>>, id: string, group: string, read: () => T,
    equals: (a: T, b: T) => boolean = compareStructural): T {
    let value = cache.get(id)
    if (!value) {
      value = computed(read, { name: `Mission@${id}.${group}`, equals })
      cache.set(id, value)
      stops.push(reaction(() => value!.get(), () => {}))
    }
    return value.get()
  }

  function rootFacts(id: string): Loaded<RootFacts> {
    return memo(facts, id, 'topology', () => {
      // The one reader overlays pending values on both rows and summaries.
      const row = pool.row('issue', id, 'summary')
      if (row === undefined || row === LOADING) return row
      const value = row as { parentId?: string | null; archived?: boolean; deletedAt?: string | null }
      return { parentId: value.parentId || null, hidden: Boolean(value.archived || value.deletedAt) }
    })
  }

  function rootFor(id: string | null): Loaded<string> {
    if (disposed) return LOADING
    if (!id) return undefined
    return memo(roots, id, 'root', () => {
      stats.roots++
      let current = id
      let value = rootFacts(current)
      if (value === undefined || value === LOADING) return value
      const seen = new Set<string>()
      while (value.parentId && !seen.has(current)) {
        seen.add(current)
        const parent = rootFacts(value.parentId)
        if (parent === LOADING) return LOADING
        if (parent === undefined || parent.hidden) break
        current = value.parentId
        value = parent
      }
      return current
    })
  }

  function memberIds(rootId: string): ReadonlySet<string> | typeof LOADING {
    if (disposed) return LOADING
    return memo(members, rootId, 'members', () => {
      stats.members++
      // A cold root is answered by its declared summary, or explicitly waits
      // for the batched loader. An unknown root still names itself in legacy.
      if (rootFacts(rootId) === LOADING) return LOADING
      const ids = new Set<string>()
      const stack = [rootId]
      while (stack.length) {
        const id = stack.pop()!
        if (ids.has(id)) continue
        ids.add(id)
        stack.push(...pool.graph.many('issue', id, MISSION_SCHEMA.members.children))
      }
      // Only sessions of admitted members can supply provenance. The declared
      // relation includes archived/headless senders and applies resume collapse.
      // Never recurse through formal children of a provenance-only member.
      for (const id of ids) {
        for (const sessionId of pool.graph.many('issue', id, MISSION_SCHEMA.members.sessions)) {
          for (const candidate of pool.graph.many('session', sessionId, MISSION_SCHEMA.members.started)) {
            ids.add(candidate)
          }
        }
      }
      return ids
    }, equalMembers)
  }

  return {
    rootFor,
    members: memberIds,
    contains(rootId, issueId) {
      const ids = memberIds(rootId)
      return ids === LOADING ? LOADING : ids.has(issueId)
    },
    stats,
    dispose() {
      if (disposed) return
      disposed = true
      for (const stop of stops) stop()
      stops.length = 0
      roots.clear(); members.clear(); facts.clear()
    },
  }
}

/** One service on the existing pool; no second runtime, source or write owner. */
export function missions(pool: MobxPool): MissionViews {
  return pool.sources.view('missions', () => createMissionViews(pool))
}
