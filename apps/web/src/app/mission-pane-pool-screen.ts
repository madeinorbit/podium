import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { initializePaneDataLayer, paneDataLayer } from '@/lib/pane-data-layer'
import type { PoolScreen } from './pool-screen-registry'

/** The navigation pane and mission view share one startup latch. Register the
 * view's declarations before ingest into the existing principal-owned pool. */
export const missionPanePoolScreen: PoolScreen = {
  optional: true,
  initialize: initializePaneDataLayer,
  enabled: () => paneDataLayer() === 'pool',
  options: () => ({ header: true, summaries: MISSION_VIEW_SUMMARIES }),
  async attach(runtime, pool) {
    if (!import.meta.env.DEV) return
    const { installMissionViewCheck } = await import('@podium/client-graph/diagnostics/mission-view-runtime-check')
    return installMissionViewCheck(runtime, pool)
  },
}
