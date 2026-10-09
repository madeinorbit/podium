/** Mobile screen sources on the app-owned pool. No feed, replica, mutation
 * owner, world enumeration, peek reader, or independently maintained
 * relationships. The mission screens open their own view model per opening
 * (`MissionScreen`); this reader only marks the phone's screen sources ready. */
import { ISSUE_BOARD_ENTITIES, ISSUE_BOARD_SOURCE_KEY } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { MOBILE_SCREEN_ENTITIES, MOBILE_SCREEN_SOURCE_KEY } from './mobile-screens-schema'
import type { MobxPool } from './pool'

export function createMobileScreenReader(_pool: MobxPool) {
  return { dispose() {} }
}

export async function attachMobileScreens(
  pool: MobxPool,
  owner?: Parameters<typeof createIssueBoardSource>[1],
) {
  await pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () =>
    createIssueBoardSource(pool, owner),
  )
  return pool.sources.ensure(MOBILE_SCREEN_SOURCE_KEY, MOBILE_SCREEN_ENTITIES, () => {
    const reader = createMobileScreenReader(pool)
    return {
      read: (entity: string) => (entity === 'mobileScreenReader' ? reader : undefined),
      dispose: () => reader.dispose(),
    }
  })
}
