/**
 * The driver interface the scheduler is written against [POD-3248].
 *
 * TWO IMPLEMENTATIONS ARE IN MIND and the interface may assume neither's
 * conveniences (spec §3.7):
 *
 *   bun:sqlite — synchronous, in-process, one shared connection. The size-one
 *     queue owns it; a transaction is `BEGIN IMMEDIATE` … `COMMIT`; statements
 *     are free once prepared, so the driver caches one statement per SQL text.
 *
 *   libsql remote (Turso, E.5) — asynchronous; every statement is a network
 *     round trip; there is no free `prepare`; writers are serialised by the
 *     platform and a concurrent writer gets a busy error; reads may run
 *     concurrently on separate connections; an interactive transaction is held
 *     open ON THE SERVER across awaits, with a 5-second budget.
 *
 * So: everything returns a promise, a "connection" is whatever `open` hands
 * back rather than a process-wide singleton, and nothing here is allowed to
 * assume that issuing a statement is cheap.
 *
 * The query layer is NOT part of this interface. The driver builds the client
 * the repositories will use ({@link StoreDriver.client}) from a router — one
 * async callback per statement — because that is the only client shape both
 * drizzle drivers can be given (drizzle's `sqlite-proxy` driver takes exactly
 * `(sql, params, method)`), and it is what makes ambient routing possible: the
 * root client's router resolves the AsyncLocalStorage scope per statement
 * instead of closing over a connection.
 */

import type { SqlParam, SqlRunResult } from '@podium/runtime/sqlite'

export type { SqlParam, SqlRunResult }

/**
 * The three lanes, each with a stated isolation (spec §3.2):
 *
 * - `read` — a consistent snapshot at one head.
 * - `write` — serialised with all other writes; sees its own writes.
 * - `exclusive` — nothing else runs. Not a transaction: it is the lane the
 *   migrator, `wal_checkpoint`, backup, the transfer fence and `close` take,
 *   each of which manages its own transaction or needs none.
 */
export type Lane = 'read' | 'write' | 'exclusive'

export type StatementMethod = 'run' | 'get' | 'all'

export interface Statement {
  readonly sql: string
  readonly params: readonly SqlParam[]
  readonly method: StatementMethod
}

export interface StatementResult {
  /** Rows for `all`; the single row (or none) for `get`; empty for `run`. */
  readonly rows: readonly unknown[]
  /** Present for `run` only. */
  readonly run?: SqlRunResult
}

/** One statement, routed to whatever scope the caller is in. */
export type StatementRouter = (statement: Statement) => Promise<StatementResult>

/**
 * SEVERAL statements as ONE driver call, routed the same way.
 *
 * This is not an optimisation on the remote path, it is the difference between
 * working and not: measured on Turso (POD-3251), the issue frame's 371
 * statements cost 37.6 s issued one at a time and 0.22 s as one batch, and
 * batch size is not a constraint (20,000 statements took 2.75 s). A contract
 * with no batch in it forces the libsql driver either to change this interface
 * later or to reach around it, and issuing each statement as its own round trip
 * inside an interactive transaction spends the write budget below.
 *
 * A batch is ATOMIC: `client.batch` runs its statements in one implicit
 * server-side transaction with a full rollback on failure, and a driver that
 * has no such call must reproduce that, not approximate it.
 */
export type BatchRouter = (statements: readonly Statement[]) => Promise<readonly StatementResult[]>

/** How a failure the driver raised should be treated. */
export type FailureClass = 'busy' | 'fatal'

/**
 * A BOUNDED retry for a busy acquisition, declared by the driver.
 *
 * Retry belongs ABOVE the transaction, never inside it: on Turso a network blip
 * closes the transaction permanently (`TRANSACTION_CLOSED`, work lost), so the
 * only safe place to try again is before any of the body has run. `attempts`
 * counts the first try, so 1 means no retry at all.
 */
export interface BusyRetryPolicy {
  readonly attempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
}

/**
 * What the driver's ENGINE imposes, declared instead of assumed by the caller.
 *
 * `writeBudgetMs` is the wall-clock a write transaction may be held before the
 * server ends it. Measured at about 9 s on Turso (POD-3251, alive at an 8 s gap
 * and dead at 10), which is why the watchdog budget has to sit below it rather
 * than being an independently chosen number: a watchdog above the hard limit
 * reports a transaction the server has already killed.
 */
export interface DriverLimits {
  readonly writeBudgetMs: number
  readonly busyRetry: BusyRetryPolicy
}

/** No server-side limit: an in-process engine holds a transaction as long as it likes. */
export const UNBOUNDED_WRITE_BUDGET_MS = Number.POSITIVE_INFINITY

/** One attempt, no retry — the correct policy for a driver with no contention. */
export const NO_BUSY_RETRY: BusyRetryPolicy = {
  attempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
}

/**
 * What the driver can run at once, per lane.
 *
 * `readConcurrency: 0` means "reads have no lane of their own": they take the
 * write slot, which is what reproduces today's bun:sqlite semantics exactly —
 * one connection, so a read outside a transaction waits behind an open body.
 * The libsql implementation sets it to the client's concurrent-request budget
 * and keeps ONE write lane, because Turso serialises writers per database and a
 * second write lane would only manufacture busy errors.
 */
export interface LanePolicy {
  readonly readConcurrency: number
}

/**
 * A connection lease. The scheduler is the only caller: it opens one per lane
 * body, drives the transaction boundary on it, and closes it in a `finally`.
 */
export interface DriverSession {
  execute(statement: Statement): Promise<StatementResult>
  /**
   * Run every statement as ONE driver call, atomically. See {@link BatchRouter}
   * for why this is on the interface rather than left to the caller to loop.
   */
  executeBatch(statements: readonly Statement[]): Promise<readonly StatementResult[]>
  /**
   * Open the transaction this lane needs. `write` is `BEGIN IMMEDIATE`
   * (`client.transaction("write")` remotely — never drizzle's own transaction
   * method, whose bun-sqlite default is deferred and whose libsql default is
   * deprecated, spec §6 rule 7). `read` may be a no-op where the lane policy
   * already guarantees the snapshot; `exclusive` opens nothing.
   */
  begin(lane: Lane): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  enterSavepoint(name: string): Promise<void>
  releaseSavepoint(name: string): Promise<void>
  rollbackToSavepoint(name: string): Promise<void>
  /** Return the connection to the driver. Always called, exactly once. */
  close(): Promise<void>
}

export interface StoreDriver<TClient = QueryClient> {
  readonly kind: string
  readonly lanes: LanePolicy
  readonly limits: DriverLimits
  /**
   * Classify a failure this driver raised. Only `busy` is retried, and only for
   * an acquisition — opening the connection, opening the transaction — because
   * nothing of the body has run yet. A driver that leaves this out classifies
   * everything as `fatal`, which is the safe default: a retry of work that may
   * already have applied is worse than a failure.
   */
  classify?(error: unknown): FailureClass
  open(lane: Lane): Promise<DriverSession>
  /**
   * A connection OUTSIDE the lanes, for the one deliberate committed-view read
   * from inside an open body (`store.outsideTransaction`). Optional because it
   * is a real capability, not a formality: it needs a second connection that can
   * read while the write connection holds the write lock, which on bun:sqlite
   * means WAL and a second handle on the same file. A driver that cannot do it
   * says so by leaving this out, and `outsideTransaction` refuses from inside a
   * body instead of deadlocking on the size-one queue.
   */
  openReader?(): Promise<DriverSession>
  /**
   * The query-layer client whose every statement goes through `route` and whose
   * batches go through `routeBatch`. Both are ambient: they resolve the scope
   * per call, which is what a client that closed over a connection could not do.
   */
  client(route: StatementRouter, routeBatch: BatchRouter): TClient
  close(): Promise<void>
}

/**
 * The prototype's stand-in for the drizzle database (spec §3.1's `drizzle`
 * field). It is deliberately the smallest thing a repository could be written
 * against, because no query layer exists yet (this issue lands before it): what
 * the interface fixes is that the client is BUILT FROM A ROUTER and is
 * therefore scope-bound, not that it is this shape.
 */
export interface QueryClient {
  run(sql: string, ...params: SqlParam[]): Promise<SqlRunResult>
  get(sql: string, ...params: SqlParam[]): Promise<unknown>
  all(sql: string, ...params: SqlParam[]): Promise<unknown[]>
  /** Every statement in one driver call, atomically. */
  batch(statements: readonly Statement[]): Promise<readonly StatementResult[]>
}

/** Build a {@link QueryClient} over a router. Shared by every driver. */
export function queryClientOver(route: StatementRouter, routeBatch: BatchRouter): QueryClient {
  return {
    batch(statements) {
      return routeBatch(statements)
    },
    async run(sql, ...params) {
      const result = await route({ sql, params, method: 'run' })
      if (!result.run) throw new Error(`driver returned no run result for: ${sql}`)
      return result.run
    },
    async get(sql, ...params) {
      const result = await route({ sql, params, method: 'get' })
      return result.rows[0]
    },
    async all(sql, ...params) {
      const result = await route({ sql, params, method: 'all' })
      return [...result.rows]
    },
  }
}
