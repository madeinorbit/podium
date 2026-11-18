import type { PoolScreen } from '@podium/client-graph/host'

/** Mission inputs are always declared on the principal-owned pool. */
export const missionPanePoolScreen: PoolScreen = {
  id: 'mission',
  options: () => ({ header: true }),
}
