import type { PoolScreen } from '@podium/client-graph/host'

export const issuePagePoolScreen: PoolScreen = {
  id: 'issuePage',
  async attach(runtime, pool) {
    const { attachIssuePageSource } = await import('@podium/client-graph/issue-page-source')
    return attachIssuePageSource(pool, { replica: runtime.replica })
  },
}
