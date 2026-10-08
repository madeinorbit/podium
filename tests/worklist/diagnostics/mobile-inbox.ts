import { createMobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import type { MobxPool } from '@podium/client-graph/pool'

/** Fixture comparisons explicitly request root membership, never serialize the
 * owning view model or its pool. Production rows read their models separately. */
export function createMobileInboxSnapshotViews(pool: MobxPool) {
  const views = createMobileInboxViews(pool)
  return {
    ...views,
    inbox: () => ({
      groups: views.inbox().groups,
      booting: views.inbox().booting,
      outboxSize: views.inbox().outboxSize,
    }),
    screening: () => ({ queue: views.screening().queue, booting: views.screening().booting }),
  }
}
