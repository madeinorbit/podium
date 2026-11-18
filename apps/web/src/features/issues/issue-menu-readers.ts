import type { IssueNavigationModel } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { type IssuePageViews, issuePages } from '@podium/client-graph/issue-page'
import { omitGone } from '@podium/client-graph/lookup'
import { readAddressedIssueRef } from '@/lib/addressed-issue-ref'
import type { IssueMenuSubmenu } from './issue-menu-config'
import { readIssueSearchChoices } from './issue-search-choices'

/** Opening a main menu asks only for its selected issues and origin labels. */
export function readIssueMenuOrigins(pool: MobxPool, issues: readonly IssueNavigationModel[]) {
  const origins = new Set(
    issues.flatMap((issue) => [
      ...(issue.parentId ? [issue.parentId] : []),
      ...(issue.deps ?? []).filter((dep) => dep.type === 'discovered-from').map((dep) => dep.id),
    ]),
  )
  return [
    ...issues,
    ...[...origins].flatMap((id) => {
      const row = omitGone(pool.row('issue', id))
      if (!row || typeof row === 'symbol') return []
      return [
        {
          ...row,
          ...readAddressedIssueRef(
            pool,
            id,
            row as { seq: number; prefix?: string; displayRef?: string },
          ),
        } as IssueNavigationModel,
      ]
    }),
  ]
}

/** Catalog demand belongs to the visible choice list, never its trigger. */
export function readIssueMenuChoices(
  pool: MobxPool,
  kind: IssueMenuSubmenu | undefined,
  views?: IssuePageViews,
  query = '',
  repoPath?: string,
) {
  if (kind !== 'labels' && kind !== 'duplicate') return undefined
  if (kind === 'duplicate')
    return readIssueSearchChoices(pool, views ?? issuePages(pool), query, repoPath)
  const rows = (views ?? issuePages(pool)).issues()
  return rows && typeof rows !== 'symbol' ? rows : undefined
}
