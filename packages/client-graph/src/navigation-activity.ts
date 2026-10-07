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

// Fresh stamp records compare only their one scalar answer.
const sameActivity = (a: Loaded<{ at: string | undefined }>, b: Loaded<{ at: string | undefined }>) =>
  a === b || (a !== undefined && b !== undefined && a !== LOADING && b !== LOADING && a.at === b.at)

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
  /** A session's stamp read from its row: the declared summary, else the row. */
  const rowStamp = (sessionId: string): Loaded<string> => {
    let session = pool.row('session', sessionId, 'summary')
    if (session && session !== LOADING && !Object.hasOwn(session, 'lastActiveAt')) {
      session = pool.row('session', sessionId)
    }
    if (session === LOADING) return LOADING
    return (session as { lastActiveAt?: string } | undefined)?.lastActiveAt || undefined
  }
  /** The shared scalar stamp ignores a read marker on an archived sender. */
  const retiredStamp = (sessionId: string): Loaded<string> => {
    try { return pool.sessionObject(sessionId).lastActivity || undefined }
    catch (error) { if (error === LOADING) return LOADING; throw error }
  }
  const history = cachedKey('NavigationActivity', 'history', (id): Loaded<string> => {
    const partition = seats.partition(MISSION_SCHEMA.members.sessions, id)
    if (partition === LOADING) return LOADING
    let latest: string | undefined
    // Cold sessions without a declared flag cannot heartbeat: aggregate them here.
    for (const sessionId of [...partition.archived, ...partition.unknown]) {
      const stamp = retiredStamp(sessionId)
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
    // Seated sessions heartbeat: their stamps are read here, with the issue.
    for (const sessionId of partition.present) {
      const stamp = rowStamp(sessionId)
      if (stamp === LOADING) return LOADING
      latest = later(latest, stamp)
    }
    // Most issues have no archived sender: no history cache is built for them.
    const archived = partition.archived.length || partition.unknown.length ? history(id) : undefined
    if (archived === LOADING) return LOADING
    return { at: later(latest, archived) }
  }, sameActivity)
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
        const value = current === id || cycle?.has(current) ? own(current) : rolled(current)
        if (value === LOADING) return LOADING
        if (value === undefined) continue
        latest = later(latest, value.at)
        if (current === id || cycle?.has(current))
          stack.push(...pool.graph.many('issue', current, 'treeChildren'))
      }
      return own(id) === undefined ? undefined : { at: latest }
    },
    sameActivity,
  )
  /** A leaf's roll-up is its own stamp: no subtree cache is built for it. */
  const rolled = (id: string) =>
    pool.graph.size('issue', id, 'treeChildren') > 0 ? subtree(id) : own(id)
  return {
    activityAt(id) {
      const value = rolled(id)
      return value === LOADING || value === undefined ? value : value.at
    },
  }
}

/** One service on the existing pool, like `missions`. */
export function navigationActivity(pool: MobxPool): NavigationActivity {
  return pool.sources.view('navigationActivity', () => createNavigationActivity(pool))
}
