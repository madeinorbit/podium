import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import type { PoolScreen } from '@/app/pool-screen-registry'
import { initializePaneDataLayer, paneDataLayer } from '@/lib/pane-data-layer'

let check: boolean | undefined
export const issuePagePoolScreen: PoolScreen = {
  initialize(ui) {
    initializePaneDataLayer(ui)
    if (check === undefined) check = paneDataLayer() === 'pool' && typeof location !== 'undefined' && new URLSearchParams(location.search).get('mobxPaneCheck') === '1'
  },
  enabled: () => paneDataLayer() === 'pool',
  options: () => ({ summaries: ISSUE_PAGE_SUMMARIES }),
  async attach(runtime, pool) {
    const { attachIssuePageSource } = await import('@podium/client-graph/issue-page-source')
    const stop = attachIssuePageSource(pool, runtime)
    let stopCheck: (() => void) | undefined
    if (check) {
      try {
        const { startIssuePageCheck } = await import('@podium/client-graph/diagnostics/issue-page-check')
        stopCheck = startIssuePageCheck(runtime, pool, report => {
          if (typeof window !== 'undefined') Object.assign(window, { __issuePageCheck: report })
        })
      } catch { /* Optional diagnostics preserve their failure isolation. */ }
    }
    return () => { stopCheck?.(); stop() }
  },
}
