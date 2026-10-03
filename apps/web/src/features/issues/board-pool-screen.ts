import type { PoolScreen } from '@podium/client-graph/host'
import {
  ISSUE_BOARD_ENTITIES,
  ISSUE_BOARD_SOURCE_KEY,
  ISSUE_BOARD_SUMMARIES,
} from '@podium/client-graph/issue-board-schema'
import { issueBoardSwitch } from './board-data-layer'

export const issueBoardPoolScreen: PoolScreen = {
  initialize: (ui) => issueBoardSwitch.initialize(ui),
  enabled: () => issueBoardSwitch.layer() === 'pool',
  options: () => ({ summaries: ISSUE_BOARD_SUMMARIES, header: true }),
  async attach(runtime, pool) {
    const { createIssueBoardSource } = await import('@podium/client-graph/issue-board-source')
    await pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () =>
      createIssueBoardSource(pool, runtime),
    )
    if (!issueBoardSwitch.checkRequested() || typeof window === 'undefined') return
    try {
      const { installBoardCheck } = await import('./board-pool-check')
      return installBoardCheck(runtime, pool)
    } catch {
      /* Optional comparison cannot retire the required read source. */
    }
  },
}
