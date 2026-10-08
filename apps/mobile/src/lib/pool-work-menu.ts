import { allowImperativeRead } from '@podium/mobx-helpers'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { sidebarLifecycle } from '@podium/client-graph/worklist/sidebar-row'
import { LOADING } from '@podium/client-graph/loading'
import { discoveredPlacement } from '@podium/client-core/values'
import { chatIssue } from '@podium/client-graph/chat-context'
import type { MobxPool } from '@podium/client-graph/pool'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type { WorkIssueMenuTarget } from './work-menu'

export interface PoolWorkMenuData {
  target: WorkIssueMenuTarget
  issues: IssueViewModel[]
  sessions: SessionView[]
}

/** The menu shows issue facts and scalar counts. Close confirmation acquires
 * its own addressed concerns only after the operator chooses a closing status;
 * delete counts raw non-shell membership without demanding session payloads. */
export function resolvePoolWorkMenu(
  pool: MobxPool,
  id: string,
  lane: WorkIssueMenuTarget['lane'] = 'live',
): PoolWorkMenuData | null {
  return allowImperativeRead(() => {
    const model = pool.issue(id)
    const raw = pool.row('issue', id) as SliceIssue | typeof LOADING | undefined
    if (!model || !raw || raw === LOADING) return null
    // Only the Closed lane shows the inverse-fold eligibility. Live menus
    // acquire close concerns on the status press, rather than warming rollups.
    const lifecycle = sidebarLifecycle(raw, lane === 'closed' && pool.worklistRow(id)!.asking, pool.inputs.passed, pool.inputs.reached)
    const issue = {
      ...raw,
      displayRef: model.displayRef,
      readAt: pool.readCursor(id),
      unread: model.unread,
      ...pool.queries.issueChildCounts(id),
      deferred: lifecycle.deferred,
    } as unknown as IssueViewModel
    const issues = [issue]
    const originId = discoveredPlacement(issue)?.originId
    if (originId && originId !== id) {
      const origin = chatIssue(pool, originId)
      if (typeof origin === 'symbol') return null
      if (origin) issues.push(origin)
    }
    return {
      target: {
        issue,
        lane,
        canBringBack: lifecycle.canBringBack,
        sessionCount: pool.graph.size('issue', id, 'pageSessions'),
      },
      issues,
      sessions: [],
    }
  })
}
