/**
 * THE SYNC TABLES A STORE'S BINDING CARRIES [POD-6977, POD-6958 design §2.1].
 *
 * The sync repository's definitions take these as `t`
 * (`prepared((db, t) => … t.changes …)`) from the table set bound to the
 * drizzle instance they are built on (`./prepared.ts`, `bindTables`), never
 * from `./schema.ts` directly, so an engine that binds its own sync tables
 * builds the same definitions on them. The server's binding
 * (`apps/server/src/store/executor/binding.ts`) spreads this set beside its own
 * schema. This file and that one are the only places a definition's tables are
 * named.
 */

import {
  appliedMutations,
  changes,
  feedIdentity,
  syncCapture,
  syncCaptureGuard,
  syncFeed,
  syncKind,
} from './schema'

/** The sync tables of the SQLite store. */
export const sqliteSyncTables = Object.freeze({
  appliedMutations,
  changes,
  feedIdentity,
  syncCapture,
  syncCaptureGuard,
  syncFeed,
  syncKind,
})

/** The sync tables a sync-repository definition reads from its `t`. */
export type SyncTables = typeof sqliteSyncTables
