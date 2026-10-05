import { cachedKey } from './cached'
import type { MobxPool } from './pool'
import { MISSION_SCHEMA } from './mission-schema'
import { LOADING, type Loaded } from './worklist/rollup'

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

export function createMissionViews(pool: MobxPool): MissionViews {
  const stats = { roots: 0, members: 0 }
  let disposed = false

  // Each memo lives while a derivation (a mounted pane, row or watch) observes
  // it and is released with its last observer. A gesture has no observer: it
  // computes afresh, bounded by the ancestry or the one mission it addresses.
  // No reaction keeps a visited id's computed alive (review finding 2).
  const rootRow = (id: string) => {
    // The one reader overlays pending values on both rows and summaries.
    let row = pool.row('issue', id, 'summary')
    // stage is required on every full issue and on our declared summary.
    // Without it an empty/partial summary cannot answer optional parents.
    if (row && row !== LOADING && !Object.hasOwn(row, 'stage')) row = pool.row('issue', id)
    return row as Loaded<{ archived?: boolean; deletedAt?: string | null }>
  }
  const hidden = cachedKey('Mission', 'hidden', (id): Loaded<boolean> => {
    const row = rootRow(id)
    return row === undefined || row === LOADING ? row : Boolean(row.archived || row.deletedAt)
  })
  const resident = cachedKey('Mission', 'resident', id => pool.row('issue', id, 'mark') !== LOADING)

  const roots = cachedKey('Mission', 'root', (id): Loaded<string> => {
    stats.roots++
    let current = id
    const value = hidden(current)
    if (value === undefined || value === LOADING) return value
    const seen = new Set<string>()
    while (!seen.has(current)) {
      seen.add(current)
      const parentId = pool.graph.one('issue', current, MISSION_SCHEMA.root.parent)
      if (!parentId) break
      const parent = hidden(parentId)
      if (parent === LOADING) return LOADING
      if (parent === undefined || parent) break
      // Navigation waits for a live ancestor's full row, as the sidebar did
      // before this cache. Archived/deleted ancestors stop at the summary.
      if (!resident(parentId)) { pool.row('issue', parentId); return LOADING }
      current = parentId
    }
    return current
  })

  const members = cachedKey('Mission', 'members', (rootId): ReadonlySet<string> | typeof LOADING => {
    stats.members++
    // A cold root is answered by its declared summary, or explicitly waits
    // for the batched loader. An unknown root still names itself in legacy.
    if (hidden(rootId) === LOADING) return LOADING
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
  })

  function rootFor(id: string | null): Loaded<string> {
    if (disposed) return LOADING
    if (!id) return undefined
    return roots(id)
  }

  function memberIds(rootId: string): ReadonlySet<string> | typeof LOADING {
    if (disposed) return LOADING
    return members(rootId)
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
      // Observed memos are released by their observers; none is retained here.
      disposed = true
    },
  }
}

/** One service on the existing pool; no second runtime, source or write owner. */
export function missions(pool: MobxPool): MissionViews {
  return pool.sources.view('missions', () => createMissionViews(pool))
}
