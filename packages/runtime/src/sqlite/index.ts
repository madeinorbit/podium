import {
  aliasBunSqliteClient,
  deserializeBunDatabase,
  openBunDatabase,
  serializeBunDatabase,
} from './bun'
import { openNodeDatabase } from './node'
import { attributeQueries } from './query-attribution'
import type { OpenOptions, SqlDatabase } from './types'

export { transaction } from './transaction'
export { bunSqliteClient } from './bun'
export {
  attributeQueries,
  formatTopQueries,
  queryAttributionEnabled,
  queryAttributionSnapshot,
  queryAttributionTotals,
  queryCallerStacks,
  queryKey,
  resetQueryAttribution,
  type QueryCost,
} from './query-attribution'
export type { OpenOptions, SqlDatabase, SqlParam, SqlRunResult, SqlStatement } from './types'

/** True when running under the Bun runtime. */
export function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && process.versions?.bun != null
}

/**
 * Open a SQLite database with the runtime's built-in driver: `bun:sqlite` under Bun,
 * `node:sqlite` under Node. Neither pulls in a native addon.
 */
export function openDatabase(path: string, opts?: OpenOptions): SqlDatabase {
  return decorate(isBunRuntime() ? openBunDatabase(path, opts) : openNodeDatabase(path, opts))
}

/**
 * A fresh in-memory database seeded from a page image (`serializeDatabase`).
 *
 * The image is COPIED, so every call yields an independent database and repeated
 * calls on one image never see each other's writes. Bun-only: `node:sqlite` has no
 * `sqlite3_deserialize`, and the one consumer — apps/server's pre-migrated store
 * fixture — runs under the Bun test runtime like the shipped binary does.
 */
export function openDatabaseFromImage(image: Uint8Array): SqlDatabase {
  if (!isBunRuntime()) {
    throw new Error('openDatabaseFromImage requires the bun:sqlite runtime (sqlite3_deserialize)')
  }
  return decorate(deserializeBunDatabase(image))
}

/** This database's whole page image, for `openDatabaseFromImage`. Bun-only. */
export function serializeDatabase(db: SqlDatabase): Uint8Array {
  const image = serializeBunDatabase(db)
  if (image === undefined) {
    throw new Error(
      'serializeDatabase requires a bun:sqlite database opened by this copy of @podium/runtime',
    )
  }
  return image
}

function decorate(db: SqlDatabase): SqlDatabase {
  // Returns `db` itself unless PODIUM_LOOP_PROFILE is set, so the default path is
  // byte-for-byte what it was. When it does decorate, the raw-handle registration
  // has to follow the new wrapper or the drizzle migrator loses its connection.
  const attributed = attributeQueries(db)
  if (attributed !== db) aliasBunSqliteClient(db, attributed)
  return attributed
}
