/**
 * Bun-only SQLite surface over `bun:sqlite`, which carries no native addon — that
 * is what keeps `bun build --compile` free of embedded `.node` files. The interface
 * stays narrow so a driver with different semantics remains pluggable in tests.
 *
 * The API mirrors the small subset Podium actually uses: prepared statements with
 * positional `?` parameters, `exec` for DDL / PRAGMA / transactions, and `close`.
 */

export type SqlParam = string | number | bigint | boolean | null | Uint8Array

export interface SqlRunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult
  /** First matching row, or `undefined` when there is none. */
  get(...params: SqlParam[]): unknown
  all(...params: SqlParam[]): unknown[]
  /**
   * Rows as positional arrays rather than objects. Present because drizzle's
   * session reaches for it; every shim must offer it so that a drizzle instance
   * can be built over the INSTRUMENTED wrapper rather than over a raw handle
   * (POD-3395: a statement issued past the wrapper is invisible to both query
   * probes, and a count that falls to zero reads as an improvement).
   */
  values(...params: SqlParam[]): unknown[][]
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  /** Run one or more statements with no parameters (DDL, PRAGMA, BEGIN/COMMIT). */
  exec(sql: string): void
  close(): void
}

/**
 * The half of {@link SqlDatabase} a transaction SPAN touches: the boundary
 * statements alone. Named so `transaction()` can say what it actually uses —
 * `@podium/sync`'s adapter is handed a narrowed connection through its own port
 * (POD-3338) and has no `close` to give.
 */
export type SqlTransactionScope = Pick<SqlDatabase, 'exec'>

export interface OpenOptions {
  readOnly?: boolean
}
