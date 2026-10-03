import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph/pool'
import type { WorkIssueMenuTarget } from './work-menu'

export interface PoolWorkMenuData {
  target: WorkIssueMenuTarget
  issues: IssueViewModel[]
  sessions: SessionView[]
}

/** Acquire menu inputs on the gesture, through the pool's one row reader.
 * R2 is the displayed roster: it collapses resume twins and excludes headless
 * agents. Delete's cascade count needs the declared raw page membership,
 * with the same shell exclusion as the legacy issue view. */
export function resolvePoolWorkMenu(
  pool: MobxPool,
  id: string,
  lane: WorkIssueMenuTarget['lane'] = 'live',
): PoolWorkMenuData | null {
  const value = pool.mobileWork.row({ kind: 'issue', id })
  if (!value || typeof value === 'symbol' || !value.sidebar) return null
  const sessions = [...pool.tables.session.keys()].flatMap((key) => {
    const verdict = pool.model('session', key)?.verdict
    return verdict && typeof verdict !== 'symbol' && verdict.sidebarSession
      ? [verdict.sidebarSession as unknown as SessionView]
      : []
  })
  const issues = [...pool.tables.issue.keys()].flatMap((key) => {
    const row = pool.mobileWork.row({ kind: 'issue', id: key })
    if (!row || typeof row === 'symbol' || !row.sidebar) return []
    const children = [...pool.graph.many('issue', key, 'treeChildren')]
    return [
      {
        ...row.sidebar.issue,
        memberSessionIds: [...pool.graph.many('issue', key, 'pageSessions')],
        childIds: children,
        childCount: children.length,
        childDoneCount: children.filter((child) => {
          const detail = pool.row('issue', child)
          return detail && typeof detail !== 'symbol' && Reflect.get(detail, 'stage') === 'done'
        }).length,
        unread: row.sidebar.issue.unread,
        deferred: row.sidebar.deferred,
      } as unknown as IssueViewModel,
    ]
  })
  const issue = issues.find((row) => row.id === id)
  return issue
    ? { target: { issue, lane, canBringBack: value.sidebar.canBringBack }, issues, sessions }
    : null
}
