import type { IssueViewModel } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import type { IssuePageViews } from '@podium/client-graph/issue-page'
import { issueSearch } from '@podium/client-graph/issue-search'
import { here } from '@podium/client-graph/lookup'

/** All web issue choice lists use the same identity-only search answer. The
 * list's existing scope rules still decide which models it offers. */
export function readIssueSearchChoices(
  pool: MobxPool,
  views: IssuePageViews,
  query = '',
  repoPath?: string,
): IssueViewModel[] {
  const rows = views.issues()
  if (!rows || typeof rows === 'symbol') return []
  const textIds = query.trim() ? pool.queries.localTextIds(query) : undefined
  const deviceIds = rows
    .filter(
      (issue) => (!repoPath || issue.repoPath === repoPath) && (!textIds || textIds.has(issue.id)),
    )
    .map((issue) => issue.id)
  return issueSearch(pool)
    .read(query, deviceIds, repoPath)
    .ids.flatMap((id) => {
      const issue = here(pool.model('issue', id))
      return issue && !issue.deletedAt ? [issue as unknown as IssueViewModel] : []
    })
}
