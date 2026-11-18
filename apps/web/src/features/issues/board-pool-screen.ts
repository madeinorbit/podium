import type { PoolScreen } from '@podium/client-graph/host'
import {
  ISSUE_BOARD_ENTITIES,
  ISSUE_BOARD_SOURCE_KEY,
} from '@podium/client-graph/issue-board-schema'

export const issueBoardPoolScreen: PoolScreen = {
  id: 'board',
  options: () => ({ header: true }),
  async attach(runtime, pool) {
    const { createIssueBoardSource } = await import('@podium/client-graph/issue-board-source')
    await pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () =>
      createIssueBoardSource(pool, runtime),
    )
  },
}
