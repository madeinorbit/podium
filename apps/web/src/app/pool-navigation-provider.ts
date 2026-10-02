import { NAVIGATION_LOADING, type NavigationProvider } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { missions } from '@podium/client-graph/mission'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { asIssueId } from '@podium/model/browser'
import { comparer, reaction } from 'mobx'

/** An addressed read port over the existing principal's pool. Row reads use
 * its single loading reader; mission invalidation belongs to the pool cache. */
export function createPoolNavigationProvider(pool: MobxPool): NavigationProvider {
  return {
    issue(id) {
      const row = pool.row('issue', id) as SliceIssue | typeof LOADING | undefined
      if (row === LOADING) return NAVIGATION_LOADING
      // Borrow the normalized row; do not retain a parallel issue index.
      return row as ReturnType<NavigationProvider['issue']>
    },
    missionRoot(id) {
      const root = missions(pool).rootFor(id)
      return root === LOADING ? NAVIGATION_LOADING : root === undefined ? undefined : asIssueId(root)
    },
    session(id) {
      const row = pool.row('session', id)
      return row === LOADING ? NAVIGATION_LOADING : row as SessionView | undefined
    },
    watch: (read, changed) => reaction(read, changed, { equals: comparer.shallow }),
  }
}
