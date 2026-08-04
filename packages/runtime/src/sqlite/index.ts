import { aliasBunSqliteClient, openBunDatabase } from './bun'
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
  const db = isBunRuntime() ? openBunDatabase(path, opts) : openNodeDatabase(path, opts)
  // Returns `db` itself unless PODIUM_LOOP_PROFILE is set, so the default path is
  // byte-for-byte what it was. When it does decorate, the raw-handle registration
  // has to follow the new wrapper or the drizzle migrator loses its connection.
  const attributed = attributeQueries(db)
  if (attributed !== db) aliasBunSqliteClient(db, attributed)
  return attributed
}
