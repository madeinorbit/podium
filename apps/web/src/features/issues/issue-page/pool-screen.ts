import type { PoolScreen } from '@podium/client-graph/host'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'

export const issuePagePoolScreen: PoolScreen = {
  id: 'issuePage',
  options: () => ({ summaries: ISSUE_PAGE_SUMMARIES }),
  async attach(runtime, pool) {
    const { attachIssuePageSource } = await import('@podium/client-graph/issue-page-source')
    return attachIssuePageSource(pool, runtime)
  },
}
