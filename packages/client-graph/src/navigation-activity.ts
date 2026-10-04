import { cachedKey } from './cached'
import { MISSION_SCHEMA } from './mission-schema'
import type { MobxPool } from './pool'
import { sessionSeats } from './session-seats'
import { LOADING, type Loaded } from './worklist/rollup'

/** Latest activity in an issue's raw formal subtree: every issue's
 * `updatedAt` and every explicit mission sender's `lastActiveAt`, hidden
 * children and archived sessions included (legacy `issueActivityAt`). */
export interface NavigationActivity {
  activityAt(id: string): Loaded<string>
}

const later = (a: string | undefined, b: string | undefined) =>
  b !== undefined && (a === undefined || b > a) ? b : a

/**
 * A maintained roll-up rather than a walk (review finding 3). Each issue
 * caches its own stamp (its row, its seated sessions, and its archived
 * sessions' maximum, cached apart so a heartbeat never re-reads history) and
 * composes its formal children's cached roll-ups. A change re-evaluates only
 * its own path to the root; a click reads cached values.
 */
export function createNavigationActivity(pool: MobxPool): NavigationActivity {
  const seats = sessionSeats(pool)
  // One session's stamp, cached apart from its row: a read marker on an
  // archived session changes its row, never the history maximum.
  const sessionStamp = cachedKey('NavigationActivity', 'stamp', (sessionId): Loaded<string> => {
    let session = pool.row('session', sessionId, 'summary')
    if (session && session !== LOADING && !Object.hasOwn(session, 'lastActiveAt')) {
      session = pool.row('session', sessionId)
    }
    if (session === LOADING) return LOADING
    return (session as { lastActiveAt?: string } | undefined)?.lastActiveAt || undefined
  })
  const history = cachedKey('NavigationActivity', 'history', (id): Loaded<string> => {
    const partition = seats.partition(MISSION_SCHEMA.members.sessions, id)
    if (partition === LOADING) return LOADING
    let latest: string | undefined
    // Cold sessions without a declared flag cannot heartbeat: aggregate them here.
    for (const sessionId of [...partition.archived, ...partition.unknown]) {
      const stamp = sessionStamp(sessionId)
      if (stamp === LOADING) return LOADING
      latest = later(latest, stamp)
    }
    return latest
  })
  /** The issue's own stamp; undefined when the issue is unknown (its subtree is not read). */
  const own = cachedKey('NavigationActivity', 'own', (id): Loaded<{ at: string | undefined }> => {
    let issue = pool.row('issue', id, 'summary')
    if (issue && issue !== LOADING && !Object.hasOwn(issue, 'updatedAt'))
      issue = pool.row('issue', id)
    if (issue === LOADING || issue === undefined) return issue
    let latest: string | undefined = (issue as { updatedAt: string }).updatedAt
    const partition = seats.partition(MISSION_SCHEMA.members.sessions, id)
    if (partition === LOADING) return LOADING
    for (const sessionId of partition.present) {
      const stamp = sessionStamp(sessionId)
      if (stamp === LOADING) return LOADING
      latest = later(latest, stamp)
    }
    const archived = history(id)
    if (archived === LOADING) return LOADING
    return { at: later(latest, archived) }
  })
  /** The formal parent cycle through `id`, read from relations alone. */
  function cycleOf(id: string): Set<string> | undefined {
    const cycle = new Set<string>([id])
    let parentId = pool.graph.one('issue', id, MISSION_SCHEMA.root.parent)
    while (parentId !== null && !cycle.has(parentId)) {
      cycle.add(parentId)
      parentId = pool.graph.one('issue', parentId, MISSION_SCHEMA.root.parent)
    }
    return parentId === id ? cycle : undefined
  }
  const subtree = cachedKey(
    'NavigationActivity',
    'subtree',
    (id): Loaded<{ at: string | undefined }> => {
      const cycle = pool.graph.size('issue', id, 'treeChildren') > 0 ? cycleOf(id) : undefined
      // Cycle members cannot compose each other's cached roll-ups. Walk the
      // cycle by its own stamps; branches off the cycle stay cached.
      const stack = [id],
        seen = new Set<string>()
      let latest: string | undefined
      while (stack.length) {
        const current = stack.pop()!
        if (seen.has(current)) continue
        seen.add(current)
        const value = current === id || cycle?.has(current) ? own(current) : subtree(current)
        if (value === LOADING) return LOADING
        if (value === undefined) continue
        latest = later(latest, value.at)
        if (current === id || cycle?.has(current))
          stack.push(...pool.graph.many('issue', current, 'treeChildren'))
      }
      return own(id) === undefined ? undefined : { at: latest }
    },
  )
  return {
    activityAt(id) {
      const value = subtree(id)
      return value === LOADING || value === undefined ? value : value.at
    },
  }
}

/** One service on the existing pool, like `missions`. */
export function navigationActivity(pool: MobxPool): NavigationActivity {
  return pool.sources.view('navigationActivity', () => createNavigationActivity(pool))
}
