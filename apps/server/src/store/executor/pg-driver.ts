/**
 * The Postgres implementation of {@link StoreDriver} [POD-6979, POD-6958 design 2.4].
 *
 * A postgres.js pool (on hosted Postgres, PgBouncer's port), with the type handlers of
 * `pg-types.ts` and `TimeZone=UTC`. The driver sends every statement itself with
 * `unsafe(sql, params, { prepare: true })` on a connection it has reserved for the
 * lease: postgres.js prepares a statement once per server connection, and the type
 * serializers only run on a prepared statement's described parameters.
 *
 * THE LANES.
 *
 * - `read`: `readConcurrency` is the pool size minus one, so reads run in parallel
 *   beside the one writer. A read body runs in `BEGIN ISOLATION LEVEL REPEATABLE READ
 *   READ ONLY`: one snapshot for the whole body. The BEGIN is not sent on its own; it
 *   goes out in the same pipeline as the body's first statement, so it costs no round
 *   trip, and a body that issues nothing sends nothing.
 * - `write`: one slot (the scheduler's). `begin('write')` in a workspace sends `BEGIN`,
 *   `SET LOCAL lock_timeout` and `SELECT 1 FROM sync_feed WHERE workspace_id = $1 FOR
 *   UPDATE` as one pipelined round trip. That lock is the single-writer rule per
 *   workspace (contract C4): every statement after it sees every earlier commit of
 *   the workspace, because those writers had to commit before the lock was granted.
 *   The workspace comes from the frame's context (`currentStoreContext()`, contract
 *   C3); a global transaction takes no workspace lock, and its BEGIN is pipelined
 *   with its first statement like a read's.
 * - `exclusive`: an in-process barrier only. Its users (migrator, checkpoint, backup,
 *   transfer fence) do not run on Postgres (design 2.7, 2.9).
 *
 * ROOT WRITES. A write statement outside any transaction autocommits. A root batch is
 * wrapped `BEGIN; statements; COMMIT` and pipelined: one round trip, atomic. A root
 * write that does carry a workspace context takes the workspace lock inside the same
 * pipeline. (Today a root statement has no context; POD-7010 makes workspace writes
 * open the workspace's transaction.)
 *
 * BATCHES INSIDE A TRANSACTION take a savepoint of their own, pipelined with the
 * statements, so a failed batch leaves the transaction as it found it
 * ({@link BatchRouter}). On failure one more round trip rolls the savepoint back.
 *
 * BUSY. Only an acquisition is retried (driver.ts, `classify`): a pool timeout or a
 * refused connection while reserving a connection, and a lock timeout (`55P03`) on
 * the workspace lock at `begin` or in a root write's pipeline. The same codes raised
 * by a body statement are fatal: part of the body may have applied. Serialization
 * failures (`40001`, `40P01`) are fatal; under the workspace lock they need a
 * transaction that spans workspaces or install tables.
 *
 * ONE POSTGRES DIFFERENCE THE DRIVER DOES NOT HIDE. A failed statement aborts the
 * whole Postgres transaction (later statements fail with `25P02` until it ends),
 * where SQLite carries on. A body that catches a statement's failure and continues
 * must use a nested transaction (a savepoint) or a batch. The COMMIT of an aborted
 * transaction is refused here with {@link PgTransactionAbortedError} rather than
 * reported as a success, which is what Postgres's own `ROLLBACK` reply to it would be.
 */

import postgres from 'postgres'
import { currentStoreContext } from './context'
import type {
  BatchRouter,
  BusyRetryPolicy,
  DriverLimits,
  DriverSession,
  FailureClass,
  Lane,
  LanePolicy,
  QueryClient,
  SqlRunResult,
  Statement,
  StatementResult,
  StatementRouter,
  StoreDriver,
} from './driver'
import { queryClientOver } from './driver'
import {
  createStoreExecutor,
  type RootStoreExecutor,
  type StoreContext,
  type StoreExecutorOptions,
} from './executor'
import {
  PG_CONNECTION_PARAMETERS,
  pgTypeHandlers,
  strictTimestampsFromEnvironment,
  translatePgError,
} from './pg-types'

export interface PgDriverOptions {
  /** `postgres://` URL of the store's database. */
  readonly url: string
  /** Connections in the pool. Reads may use all but one at once. Default 10. */
  readonly poolSize?: number
  /**
   * Read bodies run at once, at most the pool size minus one (the default). `0` makes
   * reads take the write slot, as on bun:sqlite; the committed-view reader still gets
   * a connection of its own.
   */
  readonly readConcurrency?: number
  /** How long a write waits for its workspace's lock before it is busy. Default 5 s. */
  readonly lockTimeoutMs?: number
  /** How long opening a lease waits for a pooled connection before it is busy. Default 5 s. */
  readonly acquireTimeoutMs?: number
  /** Seconds a new connection may take to connect. Default 10. */
  readonly connectTimeoutSeconds?: number
  /**
   * The gap an open transaction may leave between statements: the role's
   * `idle_in_transaction_session_timeout`, which the platform sets and the driver
   * declares (driver.ts, {@link DriverLimits}). Default 60 s.
   */
  readonly writeBudgetMs?: number
  /** Bounded retry of a busy acquisition. */
  readonly busyRetry?: BusyRetryPolicy
  /**
   * Refuse timestamp parameters that are not exact `toISOString()` form (design 2.3,
   * rule 1). Defaults to {@link strictTimestampsFromEnvironment}.
   */
  readonly strictTimestamps?: boolean
  /** Called once when the driver closes, after the pool has ended. */
  readonly onClose?: () => void
}

export interface PgStoreDriver extends StoreDriver<QueryClient> {
  readonly dialect: 'pg'
  /** Always present: only acquisition failures this driver marked are busy. */
  classify(error: unknown): FailureClass
  /** Always present: the committed-view reader is another pooled connection. */
  openReader(): Promise<DriverSession>
}

/** Default bounded retry: four attempts over about half a second, before any lock wait. */
export const PG_BUSY_RETRY: BusyRetryPolicy = {
  attempts: 4,
  initialDelayMs: 25,
  maxDelayMs: 400,
}

const DEFAULT_POOL_SIZE = 10
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10
const DEFAULT_WRITE_BUDGET_MS = 60_000

const BEGIN_READ = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
/** READ COMMITTED: the workspace lock, not the isolation level, serialises writers (2.4). */
const BEGIN_WRITE = 'BEGIN'
/**
 * The workspace lock: `SELECT 1 FROM sync_feed WHERE workspace_id = $1 FOR UPDATE`, in a
 * form that FAILS when the row is missing (division by zero, `22012`). A lock that
 * merely returned no row would let the statements pipelined behind it run and commit
 * unlocked; a failing one aborts the transaction, so they do not.
 */
const WORKSPACE_LOCK =
  'WITH locked AS (SELECT 1 FROM sync_feed WHERE workspace_id = $1 FOR UPDATE) ' +
  'SELECT 1 / (SELECT count(*)::int FROM locked) AS locked'
/** What {@link WORKSPACE_LOCK} raises when the workspace has no feed row. */
const NO_FEED_ROW = '22012'

/** No pooled connection became free within the acquisition timeout. */
export class PgPoolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no Postgres connection became free within ${timeoutMs}ms`)
    this.name = 'PgPoolTimeoutError'
  }
}

/** A write in a workspace whose `sync_feed` row does not exist (contract C4). */
export class WorkspaceFeedRowMissingError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `write refused: workspace ${workspaceId} has no sync_feed row to lock. A workspace's ` +
        'feed row is created when it is provisioned, before its first write (POD-6959 C4).',
    )
    this.name = 'WorkspaceFeedRowMissingError'
  }
}

/**
 * COMMIT reached a transaction that an earlier statement's failure had aborted.
 * Postgres rolled it back; nothing of it was kept.
 */
export class PgTransactionAbortedError extends Error {
  constructor() {
    super(
      'commit refused: a statement in this transaction failed and Postgres aborted the ' +
        'transaction, so it was rolled back. On Postgres a failed statement ends the ' +
        'transaction; catch it inside a nested transaction (a savepoint) to carry on.',
    )
    this.name = 'PgTransactionAbortedError'
  }
}

/**
 * Failures raised while ACQUIRING (a connection, or the workspace lock before the body
 * ran). Only these are `busy`; the same error raised by a body statement is not, so a
 * marker on the error object rather than its code decides.
 */
const busyAtAcquisition = new WeakSet<object>()

function markBusy(error: unknown): void {
  if (error !== null && typeof error === 'object') busyAtAcquisition.add(error)
}

/** Postgres and postgres.js codes that mean "could not get a connection now". */
const CONNECTION_BUSY_CODES = new Set([
  '57P03', // cannot_connect_now: the server is starting or shutting down
  '53300', // too_many_connections
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
])

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

const LOCK_NOT_AVAILABLE = '55P03'

type Reserved = postgres.ReservedSql<Record<string, never>>
type Rows = postgres.RowList<postgres.Row[]>

/** One pipelined step: a statement and its parameters. */
interface Step {
  readonly sql: string
  readonly params?: readonly unknown[]
}

/**
 * Send every step on `connection` at once, in order, and wait for all of them: one
 * round trip. postgres.js writes queries issued in the same turn into one socket
 * write; `.execute()` sends each now rather than when it is first awaited.
 */
async function pipeline(
  connection: Reserved,
  steps: readonly Step[],
): Promise<PromiseSettledResult<Rows>[]> {
  const queries = steps.map((step) =>
    connection
      .unsafe(step.sql, [...(step.params ?? [])] as postgres.ParameterOrJSON<never>[], {
        prepare: true,
      })
      .execute()
      .catch((error: unknown) => {
        throw translatePgError(error)
      }),
  )
  return await Promise.allSettled(queries)
}

function firstFailure(results: readonly PromiseSettledResult<Rows>[]): unknown {
  for (const result of results) if (result.status === 'rejected') return result.reason
  return undefined
}

function settledRows(result: PromiseSettledResult<Rows> | undefined): Rows {
  if (result === undefined || result.status === 'rejected') {
    throw new Error('pipeline result missing')
  }
  return result.value
}

/** A postgres.js result as the driver contract's {@link StatementResult}. */
function statementResult(statement: Statement, rows: Rows): StatementResult {
  if (statement.method === 'run') {
    // `lastInsertRowid` has no Postgres value; its users move to RETURNING (design 1.1).
    const run = { changes: rows.count ?? 0, lastInsertRowid: undefined } as unknown as SqlRunResult
    return { rows: [], run }
  }
  if (statement.method === 'get') return { rows: rows.length === 0 ? [] : [rows[0]] }
  return { rows: Array.from(rows) }
}

function stepOf(statement: Statement): Step {
  return { sql: statement.sql, params: statement.params }
}

type SessionRole = 'writer' | 'reader' | 'detached-reader' | 'exclusive'

/**
 * Where the session's transaction stands. `pending` holds a BEGIN not sent yet: it
 * goes out with the next statement, so it costs no round trip of its own.
 */
type TransactionState =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly begin: string }
  | { readonly kind: 'open' }

const NONE: TransactionState = Object.freeze({ kind: 'none' })
const OPEN: TransactionState = Object.freeze({ kind: 'open' })

interface SessionConfig {
  readonly lockTimeoutMs: number
}

function createSession(
  connection: Reserved,
  role: SessionRole,
  config: SessionConfig,
): DriverSession {
  let closed = false
  let state: TransactionState = NONE
  let nextBatchBoundary = 1
  const setLockTimeout = `SET LOCAL lock_timeout = '${config.lockTimeoutMs}ms'`

  const live = (): void => {
    if (closed) throw new Error('driver session is closed')
  }
  /** Only the write lane's session writes; a reader's write would autocommit outside the lane. */
  const assertMayWrite = (statements: readonly Statement[]): void => {
    if (role === 'writer' || role === 'exclusive') return
    const write = statements.find((statement) => statement.intent === 'write')
    if (write) throw new Error(`cannot write on a ${role} session: ${write.sql}`)
  }
  /** Take the pending BEGIN, if any, as the first step of the next pipeline. */
  const takePendingBegin = (): Step[] => {
    if (state.kind !== 'pending') return []
    const begin = state.begin
    state = OPEN
    return [{ sql: begin }]
  }
  /** The workspace lock's steps, for a write in `context`; none for a global write. */
  const lockSteps = (context: StoreContext | undefined): Step[] =>
    context?.kind === 'workspace'
      ? [{ sql: setLockTimeout }, { sql: WORKSPACE_LOCK, params: [context.workspaceId] }]
      : []
  /**
   * The failure of the lock steps, which end at index `lockAt` of `results`, or
   * undefined. A lock timeout there is busy: nothing of the body has applied.
   */
  const lockFailure = (
    results: readonly PromiseSettledResult<Rows>[],
    lockAt: number,
    context: StoreContext | undefined,
  ): unknown => {
    if (context?.kind !== 'workspace') return undefined
    for (let at = 0; at <= lockAt; at++) {
      const result = results[at]
      if (result?.status !== 'rejected') continue
      const code = errorCode(result.reason)
      if (code === NO_FEED_ROW) return new WorkspaceFeedRowMissingError(context.workspaceId)
      if (code === LOCK_NOT_AVAILABLE) markBusy(result.reason)
      return result.reason
    }
    return undefined
  }
  const rollbackQuietly = async (): Promise<void> => {
    try {
      await pipeline(connection, [{ sql: 'ROLLBACK' }])
    } catch {
      // The connection is gone; postgres.js ends its transaction with it.
    }
  }

  /**
   * A root unit: one statement or a batch outside any transaction. Reads and a single
   * global write autocommit; anything else is wrapped `BEGIN; [lock;] …; COMMIT` and
   * pipelined, so it is atomic and costs one round trip.
   */
  const runAtRoot = async (statements: readonly Statement[]): Promise<StatementResult[]> => {
    const writes = statements.some((statement) => statement.intent === 'write')
    const context = writes ? currentStoreContext() : undefined
    const locked = context?.kind === 'workspace'
    if (statements.length === 1 && !locked) {
      const [statement] = statements as [Statement]
      const [result] = await pipeline(connection, [stepOf(statement)])
      if (result?.status === 'rejected') throw result.reason
      return [statementResult(statement, settledRows(result))]
    }
    const head: Step[] = [{ sql: writes ? BEGIN_WRITE : BEGIN_READ }, ...lockSteps(context)]
    const results = await pipeline(connection, [
      ...head,
      ...statements.map(stepOf),
      { sql: 'COMMIT' },
    ])
    // A failed lock aborted the transaction: the statements behind it failed with
    // 25P02 and the COMMIT rolled back, so nothing applied.
    const locking = lockFailure(results, head.length - 1, context)
    if (locking !== undefined) throw locking
    const failure = firstFailure(results)
    if (failure !== undefined) throw failure
    const commit = settledRows(results.at(-1))
    if (commit.command === 'ROLLBACK') throw new PgTransactionAbortedError()
    return statements.map((statement, index) =>
      statementResult(statement, settledRows(results[head.length + index])),
    )
  }

  return {
    async execute(statement) {
      live()
      assertMayWrite([statement])
      if (state.kind === 'none') return (await runAtRoot([statement]))[0] as StatementResult
      const steps = [...takePendingBegin(), stepOf(statement)]
      const results = await pipeline(connection, steps)
      const failure = firstFailure(results)
      if (failure !== undefined) throw failure
      return statementResult(statement, settledRows(results.at(-1)))
    },

    async executeBatch(statements) {
      live()
      if (statements.length === 0) return []
      assertMayWrite(statements)
      if (state.kind === 'none') return await runAtRoot(statements)
      // Inside a transaction the transaction is not the batch's boundary: a savepoint
      // of its own, so a caller that catches the failure keeps a clean transaction.
      const boundary = `podium_batch_${nextBatchBoundary++}`
      const head = [...takePendingBegin(), { sql: `SAVEPOINT ${boundary}` }]
      const results = await pipeline(connection, [
        ...head,
        ...statements.map(stepOf),
        { sql: `RELEASE SAVEPOINT ${boundary}` },
      ])
      const failure = firstFailure(results)
      if (failure !== undefined) {
        const undo = await pipeline(connection, [
          { sql: `ROLLBACK TO SAVEPOINT ${boundary}` },
          { sql: `RELEASE SAVEPOINT ${boundary}` },
        ])
        const undoFailure = firstFailure(undo)
        if (undoFailure !== undefined)
          throw new AggregateError([failure, undoFailure], String(failure))
        throw failure
      }
      return statements.map((statement, index) =>
        statementResult(statement, settledRows(results[head.length + index])),
      )
    },

    async begin(lane: Lane) {
      live()
      if (state.kind !== 'none') throw new Error('a transaction is already open on this session')
      if (lane === 'exclusive') return
      if (lane === 'read') {
        state = { kind: 'pending', begin: BEGIN_READ }
        return
      }
      if (role !== 'writer') throw new Error(`cannot write on a ${role} session`)
      const context = currentStoreContext()
      if (context?.kind !== 'workspace') {
        state = { kind: 'pending', begin: BEGIN_WRITE }
        return
      }
      const steps: Step[] = [{ sql: BEGIN_WRITE }, ...lockSteps(context)]
      const results = await pipeline(connection, steps)
      const failure = lockFailure(results, steps.length - 1, context)
      if (failure !== undefined) {
        if (results[0]?.status === 'fulfilled') await rollbackQuietly()
        throw failure
      }
      state = OPEN
    },

    async commit() {
      live()
      if (state.kind !== 'open') {
        state = NONE
        return
      }
      state = NONE
      const [result] = await pipeline(connection, [{ sql: 'COMMIT' }])
      if (result?.status === 'rejected') throw result.reason
      if (settledRows(result).command === 'ROLLBACK') throw new PgTransactionAbortedError()
    },

    async rollback() {
      live()
      if (state.kind !== 'open') {
        state = NONE
        return
      }
      state = NONE
      const [result] = await pipeline(connection, [{ sql: 'ROLLBACK' }])
      if (result?.status === 'rejected') throw result.reason
    },

    async enterSavepoint(name) {
      live()
      const results = await pipeline(connection, [
        ...takePendingBegin(),
        { sql: `SAVEPOINT ${name}` },
      ])
      const failure = firstFailure(results)
      if (failure !== undefined) throw failure
    },

    async releaseSavepoint(name) {
      live()
      const [result] = await pipeline(connection, [{ sql: `RELEASE SAVEPOINT ${name}` }])
      if (result?.status === 'rejected') throw result.reason
    },

    async rollbackToSavepoint(name) {
      live()
      const [result] = await pipeline(connection, [{ sql: `ROLLBACK TO SAVEPOINT ${name}` }])
      if (result?.status === 'rejected') throw result.reason
    },

    async close() {
      if (closed) return
      closed = true
      // The scheduler always ends the transaction first; a connection must never go
      // back to the pool inside one, so a session closed with one open rolls it back.
      if (state.kind === 'open') await rollbackQuietly()
      state = NONE
      connection.release()
    },
  }
}

/** Open a Postgres store driver over a new pool on `options.url`. */
export function createPgStoreDriver(options: PgDriverOptions): PgStoreDriver {
  const poolSize = Math.max(1, Math.floor(options.poolSize ?? DEFAULT_POOL_SIZE))
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  const config: SessionConfig = {
    lockTimeoutMs: Math.max(1, Math.floor(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)),
  }
  const sql = postgres(options.url, {
    max: poolSize,
    prepare: true,
    connect_timeout: options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
    connection: { ...PG_CONNECTION_PARAMETERS },
    types: pgTypeHandlers({
      strictTimestamps: options.strictTimestamps ?? strictTimestampsFromEnvironment(),
    }) as unknown as Record<string, postgres.PostgresType>,
    onnotice: () => undefined,
  })
  const lanes: LanePolicy = {
    readConcurrency: Math.max(
      0,
      Math.min(poolSize - 1, Math.floor(options.readConcurrency ?? poolSize - 1)),
    ),
  }
  const limits: DriverLimits = {
    writeBudgetMs: options.writeBudgetMs ?? DEFAULT_WRITE_BUDGET_MS,
    busyRetry: options.busyRetry ?? PG_BUSY_RETRY,
  }
  let closed = false

  /** A pooled connection for one lease, or busy after the acquisition timeout. */
  const reserve = async (): Promise<Reserved> => {
    if (closed) throw new Error('pg driver is closed')
    const reserving = sql.reserve() as Promise<Reserved>
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PgPoolTimeoutError(acquireTimeoutMs)), acquireTimeoutMs)
    })
    try {
      return await Promise.race([reserving, timeout])
    } catch (error) {
      if (error instanceof PgPoolTimeoutError) {
        // The reservation may still be granted later; hand it straight back.
        reserving.then(
          (connection) => connection.release(),
          () => undefined,
        )
      }
      const code = errorCode(error)
      if (error instanceof PgPoolTimeoutError || (code && CONNECTION_BUSY_CODES.has(code))) {
        markBusy(error)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    kind: 'postgres',
    dialect: 'pg',
    lanes,
    limits,
    classify(error: unknown): FailureClass {
      return error !== null && typeof error === 'object' && busyAtAcquisition.has(error)
        ? 'busy'
        : 'fatal'
    },
    async open(lane) {
      const connection = await reserve()
      const role: SessionRole =
        lane === 'read' ? 'reader' : lane === 'exclusive' ? 'exclusive' : 'writer'
      return createSession(connection, role, config)
    },
    async openReader() {
      return createSession(await reserve(), 'detached-reader', config)
    },
    client(route: StatementRouter, routeBatch: BatchRouter): QueryClient {
      return queryClientOver(route, routeBatch)
    },
    async close() {
      if (closed) return
      closed = true
      await sql.end({ timeout: 5 })
      options.onClose?.()
    },
  }
}

export interface PgStoreExecutorOptions
  extends Omit<StoreExecutorOptions<QueryClient>, 'driver'>,
    PgDriverOptions {}

/** The Postgres composition root: one driver and its executor. */
export function createPgStoreExecutor(
  options: PgStoreExecutorOptions,
): RootStoreExecutor<QueryClient> {
  const {
    url,
    poolSize,
    readConcurrency,
    lockTimeoutMs,
    acquireTimeoutMs,
    connectTimeoutSeconds,
    writeBudgetMs,
    busyRetry,
    strictTimestamps,
    onClose,
    ...executor
  } = options
  const driverOptions: PgDriverOptions = {
    url,
    ...(poolSize !== undefined ? { poolSize } : {}),
    ...(readConcurrency !== undefined ? { readConcurrency } : {}),
    ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
    ...(acquireTimeoutMs !== undefined ? { acquireTimeoutMs } : {}),
    ...(connectTimeoutSeconds !== undefined ? { connectTimeoutSeconds } : {}),
    ...(writeBudgetMs !== undefined ? { writeBudgetMs } : {}),
    ...(busyRetry !== undefined ? { busyRetry } : {}),
    ...(strictTimestamps !== undefined ? { strictTimestamps } : {}),
    ...(onClose !== undefined ? { onClose } : {}),
  }
  return createStoreExecutor<QueryClient>({
    driver: createPgStoreDriver(driverOptions),
    ...executor,
  })
}
