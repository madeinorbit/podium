import type { PoolScreen } from '@podium/client-graph/host'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'

/** Mission inputs are always declared on the principal-owned pool. */
export const missionPanePoolScreen: PoolScreen = {
  id: 'mission',
  options: () => ({ header: true, summaries: MISSION_VIEW_SUMMARIES }),
}
