/**
 * Runtime-neutral SQLite surface. Implemented by `node:sqlite` (Node) and
 * `bun:sqlite` (Bun) so the persistence layer carries no native addon on either
 * runtime — which keeps `bun build --compile` free of embedded `.node` files.
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
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  /** Run one or more statements with no parameters (DDL, PRAGMA, BEGIN/COMMIT). */
  exec(sql: string): void
  close(): void
}

export interface OpenOptions {
  readOnly?: boolean
}
