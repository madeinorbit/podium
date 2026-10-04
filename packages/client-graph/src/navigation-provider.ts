import { NAVIGATION_LOADING, type NavigationProvider } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId } from '@podium/model/browser'
import { parseSessionRef } from '@podium/protocol'
import { missions } from './mission'
import { navigationActivity } from './navigation-activity'
import type { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'
import type { SliceIssue } from './shared/slice-types'
import { LOADING } from './worklist/rollup'

/** An addressed read port over the existing principal's pool. Row reads use
 * its single loading reader; mission invalidation belongs to the pool cache. */
export function createPoolNavigationProvider(pool: MobxPool): NavigationProvider {
  return {
    issue(id) {
      let row = pool.row('issue', id, 'summary') as SliceIssue | typeof LOADING | undefined
      if (
        row &&
        row !== LOADING &&
        (!Object.hasOwn(row, 'id') || !Object.hasOwn(row, 'updatedAt'))
      ) {
        row = pool.row('issue', id) as SliceIssue | typeof LOADING | undefined
      }
      if (row === LOADING) return NAVIGATION_LOADING
      // Borrow the normalized row; do not retain a parallel issue index.
      return row as ReturnType<NavigationProvider['issue']>
    },
    missionRoot(id) {
      const root = missions(pool).rootFor(id)
      return root === LOADING
        ? NAVIGATION_LOADING
        : root === undefined
          ? undefined
          : asIssueId(root)
    },
    missionMembers(rootId) {
      const ids = missions(pool).members(rootId)
      return ids === LOADING ? NAVIGATION_LOADING : ids
    },
    session(id) {
      let row = pool.row('session', id)
      if (row === LOADING) return NAVIGATION_LOADING
      if (row !== undefined || !parseSessionRef(id.trim())) return row as SessionView | undefined
      // Permanent birth refs are also local navigation targets. The declared
      // reference question names the candidates; it never enumerates history.
      // Cold candidates answer through the declared scalar summary.
      const ref = id.trim()
      let pending = false
      for (const key of pool.queries.indexed({ kind: 'sessionReference', ref }).sort()) {
        const summary = pool.row('session', key, 'summary')
        if (summary === LOADING) {
          pending = true
          continue
        }
        if ((summary as { displayRef?: string } | undefined)?.displayRef !== ref) continue
        row = pool.row('session', key)
        return row === LOADING ? NAVIGATION_LOADING : (row as SessionView | undefined)
      }
      return pending ? NAVIGATION_LOADING : undefined
    },
    sessionMembership(id) {
      const row = pool.row('session', id, 'summary-fields')
      return row === LOADING ? NAVIGATION_LOADING : row as ReturnType<NonNullable<NavigationProvider['sessionMembership']>>
    },
    activityAt(id) {
      const latest = navigationActivity(pool).activityAt(id)
      return latest === LOADING ? NAVIGATION_LOADING : latest
    },
    issueReadAt: (id) => pool.readCursor(id),
    watch: (read, changed) => createPoolProjection(pool, read).subscribe(changed),
  }
}
