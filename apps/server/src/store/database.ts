/**
 * THE STORE DATABASE'S OWN STATEMENTS [POD-6959 design 2.4, task POD-7010].
 *
 * `StoreDatabase` (in `../store.ts`, beside `SessionStore`: each needs the other
 * at run time, and two modules would be a runtime import cycle) runs these
 * itself, in the global context. Today that is one: the provisioning insert.
 */

import { sql } from 'drizzle-orm'
import { preparedGlobal, type StoreTables } from './executor/sync-drizzle'

/**
 * THE PROVISIONING INSERT [contracts C3 and C4; `PROVISION_WORKSPACE_FEED` in
 * `./cross-workspace-allowlist.ts`].
 *
 * A workspace's `sync_feed` row is its provisioning row: on Postgres every write
 * transaction of the workspace begins by locking it (C4), so it must exist
 * before the workspace's first write. It is inserted in the GLOBAL context,
 * because the row the workspace's own transaction would lock does not exist
 * yet, and with `ON CONFLICT DO NOTHING`, so provisioning twice keeps the first
 * row's identity and counters.
 *
 * It is the one global definition that names a workspace table, which is why
 * its `t` is widened from the install tables a global definition is given; the
 * workspace-scope audit admits it by its allowlist entry. The workspace comes
 * from the caller, since a global handle carries none.
 *
 * The values are a fresh feed's, the same the migration gives a fresh install's
 * row (`20261111141656_tenant-sync-feed`): head 0, floor 1 (head + 1, empty).
 */
export const provisionWorkspaceFeed = preparedGlobal((db, t) =>
  db
    .insert((t as unknown as StoreTables).syncFeed)
    .values({
      workspaceId: sql.placeholder('workspaceId'),
      feedId: sql.placeholder('feedId'),
      epoch: sql.placeholder('epoch'),
      mintedAt: sql.placeholder('mintedAt'),
      headSeq: 0,
      floorSeq: 1,
    })
    .onConflictDoNothing()
    .prepare(),
)
