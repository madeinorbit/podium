import { openBunDatabase } from './bun.js'
import { openNodeDatabase } from './node.js'
import type { OpenOptions, SqlDatabase } from './types.js'

export type { OpenOptions, SqlDatabase, SqlParam, SqlRunResult, SqlStatement } from './types.js'

/** True when running under the Bun runtime. */
export function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && process.versions?.bun != null
}

/**
 * Open a SQLite database with the runtime's built-in driver: `bun:sqlite` under Bun,
 * `node:sqlite` under Node. Neither pulls in a native addon.
 */
export function openDatabase(path: string, opts?: OpenOptions): SqlDatabase {
  return isBunRuntime() ? openBunDatabase(path, opts) : openNodeDatabase(path, opts)
}
