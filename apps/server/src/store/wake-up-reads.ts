// workspace-scoped (POD-6959)
/**
 * THE WAKE-UP POLL'S ONE READ [POD-7292, POD-6954 design 4.2].
 *
 * The safety net under the workspace wake-up (`workspace-wake-up.ts`): every few seconds a
 * process reads the feed heads of the workspaces it has subscribers for, in ONE statement,
 * and wakes the subscribers of each workspace whose head moved. One statement per process
 * per tick, however many workspaces it serves, so the poll's cost does not grow with them.
 *
 * The ids are ONE bound JSON array parameter, so the statement has one shape: read with
 * `json_each` on SQLite and `json_array_elements_text` on Postgres.
 */

import type { WorkspaceId } from '@podium/model'
import { sql } from 'drizzle-orm'
import { WAKE_UP_FEED_HEADS } from './cross-workspace-allowlist'
import { dialectOf } from './executor/dialect-prepared'
import type { FleetDb } from './executor/sync-drizzle'
import { preparedAcross } from './executor/sync-drizzle'

/** The feed head of each listed workspace that has a feed. */
const readFeedHeads = preparedAcross(WAKE_UP_FEED_HEADS, (db, t) =>
  db
    .select({ workspaceId: t.syncFeed.workspaceId, headSeq: t.syncFeed.headSeq })
    .from(t.syncFeed)
    .where(
      dialectOf(db) === 'pg'
        ? sql`${t.syncFeed.workspaceId} IN (SELECT ids.id COLLATE "C" FROM json_array_elements_text(CAST(${sql.placeholder('ids')} AS json)) AS ids(id))`
        : sql`${t.syncFeed.workspaceId} IN (SELECT value FROM json_each(${sql.placeholder('ids')}))`,
    )
    .prepare(),
)

/**
 * The heads of `workspaceIds`' feeds, by workspace. A workspace without a feed row (not
 * provisioned, or removed) is absent from the map.
 */
export async function feedHeadsOf(
  fleet: FleetDb,
  workspaceIds: readonly WorkspaceId[],
): Promise<Map<WorkspaceId, number>> {
  const heads = new Map<WorkspaceId, number>()
  if (workspaceIds.length === 0) return heads
  for (const row of await readFeedHeads(fleet).all({ ids: JSON.stringify(workspaceIds) })) {
    heads.set(row.workspaceId as WorkspaceId, Number(row.headSeq))
  }
  return heads
}
