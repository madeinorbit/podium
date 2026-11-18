import type { IssueViewModel } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import type { IssuePageViews } from '@podium/client-graph/issue-page'
import { type IssueSearchResult, issueSearch } from '@podium/client-graph/issue-search'
import { here } from '@podium/client-graph/lookup'

/** All web issue choice lists use the same identity-only search answer. The
 * list's existing scope rules still decide which models it offers. */
export function readIssueSearchChoiceIds(
  pool: MobxPool,
  query = '',
  repoPath?: string,
): IssueSearchResult {
  const textIds = query.trim() ? pool.queries.localTextIds(query) : undefined
  const deviceIds = pool.queries
    .ids({ kind: 'pageIssues' })
    .filter((id) => !textIds || textIds.has(id))
  return issueSearch(pool).read(query, deviceIds, repoPath)
}

/** Rows resolve only at the renderer boundary; the answer itself keeps IDs. */
export function readIssueSearchChoices(
  pool: MobxPool,
  _views: IssuePageViews,
  query = '',
  repoPath?: string,
): IssueViewModel[] {
  return readIssueSearchChoiceIds(pool, query, repoPath).ids.flatMap((id) => {
    const issue = here(pool.model('issue', id))
    return issue && !issue.deletedAt ? [issue as unknown as IssueViewModel] : []
  })
}
