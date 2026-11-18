import type { IssueViewModel } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import type { IssuePageViews } from '@podium/client-graph/issue-page'
import { readIssueSearchChoiceIds } from '@podium/client-graph/issue-search-choices'
import { here } from '@podium/client-graph/lookup'

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
