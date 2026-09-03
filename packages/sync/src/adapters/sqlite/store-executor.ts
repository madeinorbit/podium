/**
 * THE STORE'S EXECUTOR, NARROWED TO WHAT THIS ADAPTER USES (POD-3338, spec §6
 * rule 20).
 *
 * `SyncRepository` is the one repository in the set that is not in `apps/server`,
 * so it was the one still handed the raw connection after [0.12] bound every
 * other constructor to the executor. A package may not import an app, and rule 2
 * deliberately keeps the executor inside persistence rather than in
 * `@podium/runtime` — so the package DECLARES the interface it requires and the
 * server's executor satisfies it. That is dependency inversion, and it is the
 * pattern this epic already set one file away: `./server-tables.ts` injected the
 * two server-owned tables for exactly this reason.
 *
 * WHY THE TYPES ARE STRUCTURAL AND NOT `typeof StoreExecutor`. Naming the
 * server's binding is the import this file exists to avoid — the same reasoning
 * `./server-tables.ts` records, and it is the whole reason the shapes below are
 * spelled out rather than referenced. `apps/server`'s `StoreExecutor` satisfies
 * {@link SyncStoreExecutor} structurally, so a member this adapter depends on
 * cannot be dropped from the executor without a compile error at the composition
 * root.
 *
 * WHY IT NAMES `legacy` AND NOTHING ELSE. The port is what this repository
 * ACTUALLY uses, not a second vocabulary for the executor: a wide port would be
 * the thing rule 20 says this is not. Today the sync adapter issues synchronous
 * `bun:sqlite` statements, and the ONLY member of the executor that can carry a
 * synchronous statement is the transitional `legacy` handle — `drizzle` is the
 * query-layer client and it is asynchronous, and `transact`/`read` return
 * promises. So the port is `legacy`, and it grows a query-layer member when the
 * adapter's own conversion wave gives it one to use.
 *
 * THE FIELD IS OPTIONAL BECAUSE THE EXECUTOR'S IS. A fake or remote driver has
 * no `bun:sqlite` connection, so an adapter built over one has to fail at
 * CONSTRUCTION rather than at its first statement, where the stack no longer
 * says what was mis-wired. `SyncRepository`'s constructor is where that refusal
 * lives.
 *
 * This type is the ADAPTER's and it stays here: `check-boundaries` rule 11 keeps
 * the kernel free of SQLite and of anything under `adapters/`.
 */

/** A bound parameter, as `bun:sqlite` and the libsql client both accept it. */
export type SyncSqlParam = string | number | bigint | boolean | null | Uint8Array

/** What a write reports back. `bigint` is the driver's, not a widening: SQLite
 *  row ids exceed `Number.MAX_SAFE_INTEGER` and the handle says so. */
export interface SyncSqlRunResult {
  readonly changes: number | bigint
  readonly lastInsertRowid: number | bigint
}

/** A prepared statement, in the three shapes this adapter decodes. */
export interface SyncSqlStatement {
  run(...params: SyncSqlParam[]): SyncSqlRunResult
  /** The first matching row, or `undefined` when there is none. */
  get(...params: SyncSqlParam[]): unknown
  all(...params: SyncSqlParam[]): unknown[]
}

/**
 * The connection behind the executor's legacy handle, narrowed to the two
 * methods this adapter's work reaches: `prepare` for its own statements, and
 * `exec` for the BEGIN/COMMIT/SAVEPOINT the nesting-safe transaction helper
 * issues on its behalf. `close` is deliberately absent — the adapter is handed a
 * connection, it does not own its lifetime.
 */
export interface SyncSqlConnection {
  prepare(sql: string): SyncSqlStatement
  /** Statements with no parameters — the transaction helper's boundaries. */
  exec(sql: string): void
}

/** What the composition root hands {@link SyncRepository} alongside the tables. */
export interface SyncStoreExecutor {
  /**
   * The raw handle, for a repository not yet on the query layer. Transitional in
   * the executor and transitional here: POD-3267 deletes the field, and by then
   * this adapter's conversion wave has replaced what reads it.
   */
  readonly legacy: SyncSqlConnection | undefined
}

/**
 * The port over a bare connection, for a composition root that holds one and no
 * executor.
 *
 * There is exactly one such root in the product — `apps/server`'s backup/restore
 * path, which opens a database of its own to re-mint the restored feed epoch and
 * has no store, no scheduler and nothing to bind an executor to — plus this
 * package's own fixtures. It exists so those callers do not each invent their
 * own spelling of the same one-field object, NOT as a second way for the store
 * to hand its connection over: the store passes its executor, which satisfies
 * {@link SyncStoreExecutor} on its own.
 */
export function syncStoreExecutorOver(legacy: SyncSqlConnection): SyncStoreExecutor {
  return { legacy }
}
