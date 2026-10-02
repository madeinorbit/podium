import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import type { PoolScreen } from '@/app/pool-screen-registry'
import { initializePaneDataLayer, paneDataLayer } from '@/lib/pane-data-layer'

let check: boolean | undefined
export const issuePagePoolScreen: PoolScreen = {
  optional: true,
  initialize(ui) {
    initializePaneDataLayer(ui)
    if (check === undefined) check = paneDataLayer() === 'pool' && typeof location !== 'undefined' && new URLSearchParams(location.search).get('mobxPaneCheck') === '1'
  },
  enabled: () => paneDataLayer() === 'pool',
  options: () => ({ summaries: ISSUE_PAGE_SUMMARIES }),
  async attach(runtime, pool) {
    if (!check) return
    const { startIssuePageCheck } = await import('@podium/client-graph/diagnostics/issue-page-check')
    return startIssuePageCheck(runtime, pool, report => {
      if (typeof window !== 'undefined') Object.assign(window, { __issuePageCheck: report })
    })
  },
}
