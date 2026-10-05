import type { IssueNavigationModel } from '@podium/client-core/values'
import { issuePages } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph'
import type { IssueMenuSubmenu } from './issue-menu-config'

/** Opening a main menu asks only for its selected issues and origin labels. */
export function readIssueMenuOrigins(pool: MobxPool, issues: readonly IssueNavigationModel[]) {
  const origins = new Set(issues.flatMap(issue => [
    ...(issue.parentId ? [issue.parentId] : []),
    ...(issue.deps ?? []).filter(dep => dep.type === 'discovered-from').map(dep => dep.id),
  ]))
  return [...issues, ...[...origins].flatMap(id => {
    const row = pool.row('issue', id, 'summary-fields')
    if (!row || typeof row === 'symbol') return []
    const ref = pool.references.readById(id)
    return [{ ...row, ...(ref && typeof ref !== 'symbol' ? { displayRef: ref.ref } : {}) } as IssueNavigationModel]
  })]
}

/** Catalog demand belongs to the visible choice list, never its trigger. */
export function readIssueMenuChoices(pool: MobxPool, kind: IssueMenuSubmenu | undefined) {
  if (kind !== 'labels' && kind !== 'duplicate') return undefined
  const rows = issuePages(pool).issues()
  return rows && typeof rows !== 'symbol' ? rows : undefined
}
