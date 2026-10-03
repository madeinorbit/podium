import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { discoveredPlacement } from '@podium/client-core/viewmodels'
import type { MobxPool } from '@podium/client-graph/pool'
import type { WorkIssueMenuTarget } from './work-menu'

export interface PoolWorkMenuData {
  target: WorkIssueMenuTarget
  issues: IssueViewModel[]
  sessions: SessionView[]
}

/** Acquire only the pressed issue's neighbourhood through the pool reader.
 * Close warnings include its headless and archived senders. Delete's cascade
 * count separately uses raw, non-shell membership before resume collapse. */
export function resolvePoolWorkMenu(
  pool: MobxPool,
  id: string,
  lane: WorkIssueMenuTarget['lane'] = 'live',
): PoolWorkMenuData | null {
  const value = pool.mobileWork.row({ kind: 'issue', id })
  if (!value || typeof value === 'symbol' || !value.sidebar) return null
  const sessions: SessionView[] = []
  for (const key of pool.graph.many('issue', id, 'missionSessions')) {
    const verdict = pool.model('session', key)?.verdict
    if (typeof verdict === 'symbol') return null
    if (verdict?.sidebarSession) sessions.push(verdict.sidebarSession as unknown as SessionView)
  }
  const children = [...pool.graph.many('issue', id, 'treeChildren')]
  let childDoneCount = 0
  for (const child of children) {
    const detail = pool.row('issue', child)
    if (typeof detail === 'symbol') return null
    if (detail && Reflect.get(detail, 'stage') === 'done') childDoneCount++
  }
  const issue = {
    ...value.sidebar.issue,
    memberSessionIds: [...pool.graph.many('issue', id, 'pageSessions')],
    childIds: children,
    childCount: children.length,
    childDoneCount,
    deferred: value.sidebar.deferred,
  } as unknown as IssueViewModel
  const issues = [issue]
  const originId = discoveredPlacement(issue)?.originId
  if (originId && originId !== id) {
    const origin = pool.missionViews.catalogIssue(originId)
    if (typeof origin === 'symbol') return null
    if (origin) issues.push(origin as IssueViewModel)
  }
  return { target: { issue, lane, canBringBack: value.sidebar.canBringBack }, issues, sessions }
}
