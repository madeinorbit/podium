import { NAVIGATION_LOADING, type NavigationProvider } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { missions } from '@podium/client-graph/mission'
import { knownSessionIds } from '@podium/client-graph/enumerate'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { asIssueId } from '@podium/model/browser'
import { parseSessionRef } from '@podium/protocol'

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
      let row = pool.row('session', id)
      if (row === LOADING) return NAVIGATION_LOADING
      if (row !== undefined || !parseSessionRef(id.trim())) return row as SessionView | undefined
      // Permanent birth refs are also local navigation targets. Only this
      // uncommon ref form enumerates keys; ordinary session ids stay addressed.
      // Cold candidates answer through the declared scalar summary.
      let pending = false
      for (const key of knownSessionIds(pool)) {
        const summary = pool.row('session', key, 'summary')
        if (summary === LOADING) { pending = true; continue }
        if ((summary as { displayRef?: string } | undefined)?.displayRef !== id.trim()) continue
        row = pool.row('session', key)
        return row === LOADING ? NAVIGATION_LOADING : row as SessionView | undefined
      }
      return pending ? NAVIGATION_LOADING : undefined
    },
    watch: (read, changed) => createPoolProjection(pool, read).subscribe(changed),
  }
}
