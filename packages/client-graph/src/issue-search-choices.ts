import { type IssueSearchResult, issueSearch } from './issue-search'
import type { MobxPool } from './pool'

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
