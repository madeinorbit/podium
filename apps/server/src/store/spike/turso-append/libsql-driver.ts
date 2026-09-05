/**
 * A libsql remote driver written against the executor's port [POD-3250, port from POD-3248].
 *
 * This is a PROOF, not the shipping driver. What it exists to establish is that
 * the interface issue 0.6 settled — {@link StoreDriver}, {@link DriverSession},
 * {@link DriverLimits} — can be implemented over `@libsql/client` against a real
 * Turso database without changing its shape, and that the change-log append
 * written against it keeps its contract. [E.5] builds the real one; if this file
 * had to bend the port to work, that is the finding.
 *
 * THE ONE THING IT MAY NOT DO IS OPEN A TRANSACTION BY EXECUTING SQL.
 * `c.execute('BEGIN IMMEDIATE')` returns success on Turso and does nothing:
 * every `execute` is its own hrana stream, so the transaction does not survive
 * to the next call and a following `ROLLBACK` fails with "cannot rollback - no
 * transaction is active" (POD-3251 gate 3). A driver that opened transactions
 * that way would be silently non-transactional — every append committing
 * chunk-by-chunk, which is exactly the failure this proof exists to rule out.
 * So `begin` goes through `client.transaction(mode)` and the session holds the
 * returned object.
 *
 * THE MODE IS PASSED EXPLICITLY (spec §6 rule 7). `transaction('write')` is
 * `BEGIN IMMEDIATE`; `transaction()` with no argument happens to default to
 * `write` in the installed 0.18.0, but the client marks that default deprecated
 * and will remove it, so nothing here relies on it.
 */

import type { Client, InValue, ResultSet, Transaction } from '@libsql/client/web'
import type {
  DriverLimits,
  DriverSession,
  FailureClass,
  Lane,
  LanePolicy,
  QueryClient,
  SqlParam,
  Statement,
  StatementResult,
  StoreDriver,
} from '../../executor/driver'
import { NO_BUSY_RETRY, queryClientOver } from '../../executor/driver'
import type { CountedClient } from './client'

/**
 * The measured server-side budget for an interactive transaction.
 *
 * IT BOUNDS THE GAP BETWEEN STATEMENTS, NOT THE TRANSACTION'S DURATION, and the
 * distinction is not pedantry — read as a duration it would make the literal
 * 250-row append (27.8 s of continuous statements on the hosted database)
 * impossible. It is not: it commits. Measured both ways (POD-3250 proof 9): a
 * 21.6 s transaction with a statement every 2 s COMMITTED, and a 12.2 s one with
 * a single idle gap was reaped with
 * `SQLITE_BUSY: … the stream was idle for too long`.
 *
 * So a watchdog derived from this number has to measure TIME SINCE THE LAST
 * STATEMENT. One measuring time since `begin` would fire on transactions the
 * server is perfectly happy with, and would miss the one thing that actually
 * kills them. The port said "wall-clock … held" and its watchdog timed from
 * `begin`; both were corrected against this measurement in POD-3345.
 *
 * DECLARED here rather than assumed by a caller because the scheduler refuses a
 * watchdog at or above it: a watchdog above the hard limit would report a
 * transaction the server has already killed.
 */
export const TURSO_WRITE_BUDGET_MS = 9_000

/**
 * The busy-retry policy this proof recommends, and the measurement behind it is
 * in `../../../../../docs/internal/pod-3250-turso-append-proof.md`.
 *
 * Bounded, above the transaction and only for acquisition — a network blip
 * closes a remote transaction permanently, so retrying anything whose body has
 * begun risks applying work twice.
 */
export const TURSO_BUSY_RETRY = {
  attempts: 3,
  initialDelayMs: 50,
  maxDelayMs: 500,
} as const

function unwrapCause(error: unknown): unknown {
  let current = error
  const seen = new Set<unknown>()
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const cause = (current as { cause?: unknown }).cause
    if (cause === undefined) break
    current = cause
  }
  return current
}

/**
 * Which libsql failures are worth another attempt.
 *
 * `SQLITE_BUSY` is the only retryable class, and on Turso it arrives in two
 * shapes that mean different things: a genuine write conflict, and the idle
 * reaper's "interactive transaction was rolled back because the stream was idle
 * for too long". Both are safe to retry AT ACQUISITION, which is the only place
 * the port allows a retry. Everything else — including `TRANSACTION_CLOSED`,
 * which means the work is already lost — is fatal.
 */
export function classifyLibsqlFailure(error: unknown): FailureClass {
  const original = unwrapCause(error)
  const code = (original as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.toUpperCase().includes('SQLITE_BUSY')) return 'busy'
  const message = original instanceof Error ? original.message : String(original)
  return /SQLITE_BUSY|database is locked/i.test(message) ? 'busy' : 'fatal'
}

/**
 * libsql's parameter type is wider than the port's — every {@link SqlParam} is a
 * valid `InValue`, so this is a widening the compiler checks rather than a cast.
 */
function toArgs(params: readonly SqlParam[]): InValue[] {
  return [...params]
}

function toRunResult(result: ResultSet): StatementResult['run'] {
  return {
    changes: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid ?? 0n,
  }
}

function decode(statement: Statement, result: ResultSet): StatementResult {
  if (statement.method === 'run') return { rows: [], run: toRunResult(result) }
  return { rows: statement.method === 'get' ? result.rows.slice(0, 1) : result.rows }
}

/** What a session issues statements against: the client, or an open transaction on it. */
type Issuer = Pick<Client, 'execute' | 'batch'>

class LibsqlSession implements DriverSession {
  private tx: Transaction | undefined
  /** Savepoint depth, so a batch inside a transaction can wrap itself atomically. */
  private savepointSerial = 0

  constructor(private readonly client: Client) {}

  private get issuer(): Issuer {
    return this.tx ?? this.client
  }

  async execute(statement: Statement): Promise<StatementResult> {
    const result = await this.issuer.execute({
      sql: statement.sql,
      args: toArgs(statement.params),
    })
    return decode(statement, result)
  }

  /**
   * One driver call for every statement, atomic even inside an open transaction.
   *
   * `client.batch` runs its statements in one implicit server-side transaction
   * with a full rollback on failure — but INSIDE an interactive transaction that
   * is not the boundary the port promises: a caller that catches the batch's
   * error and carries on would otherwise keep the prefix that applied. So a
   * batch issued inside a transaction wraps itself in a savepoint, which is what
   * the port's {@link BatchRouter} contract requires of any driver.
   */
  async executeBatch(statements: readonly Statement[]): Promise<readonly StatementResult[]> {
    if (statements.length === 0) return []
    const built = statements.map((s) => ({ sql: s.sql, args: toArgs(s.params) }))
    if (this.tx === undefined) {
      const results = await this.client.batch(built, 'write')
      return results.map((r, i) => decode(statements[i] as Statement, r))
    }
    this.savepointSerial += 1
    const name = `batch_${this.savepointSerial}`
    await this.enterSavepoint(name)
    try {
      const results = await this.tx.batch(built)
      await this.releaseSavepoint(name)
      return results.map((r, i) => decode(statements[i] as Statement, r))
    } catch (error) {
      await this.rollbackToSavepoint(name)
      await this.releaseSavepoint(name)
      throw error
    }
  }

  async begin(lane: Lane): Promise<void> {
    if (lane === 'exclusive') return
    // The driver IS the port's implementation, so this is the one call site the
    // transaction-port rule exists to require rather than forbid. This file is
    // named in the lint's `TRANSACTION_OPENERS` for that reason (spec §6 rule 22).
    this.tx = await this.client.transaction(lane === 'write' ? 'write' : 'read')
  }

  async commit(): Promise<void> {
    await this.tx?.commit()
    this.tx = undefined
  }

  async rollback(): Promise<void> {
    await this.tx?.rollback()
    this.tx = undefined
  }

  async enterSavepoint(name: string): Promise<void> {
    await this.issuer.execute(`SAVEPOINT ${quote(name)}`)
  }

  async releaseSavepoint(name: string): Promise<void> {
    await this.issuer.execute(`RELEASE ${quote(name)}`)
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    await this.issuer.execute(`ROLLBACK TO ${quote(name)}`)
  }

  async close(): Promise<void> {
    // An open transaction here means the body left without deciding. Roll it
    // back rather than letting the server's idle reaper decide for us nine
    // seconds later, by which time the connection is holding the write lock
    // against every other writer.
    if (this.tx !== undefined) await this.rollback()
  }
}

/** A savepoint name is generated here, never taken from a caller. */
function quote(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unusable savepoint name: ${name}`)
  return `"${name}"`
}

/**
 * ONE WRITE LANE, and reads bounded by the client's concurrent-request budget.
 *
 * Turso serialises writers per database, so a second write lane could only
 * manufacture the contention this proof measures. The read figure is the
 * client's default concurrency.
 */
export const LIBSQL_LANES: LanePolicy = { readConcurrency: 20 }

export class LibsqlSpikeDriver implements StoreDriver {
  readonly kind = 'libsql-remote-spike'
  readonly lanes = LIBSQL_LANES
  readonly limits: DriverLimits = {
    writeBudgetMs: TURSO_WRITE_BUDGET_MS,
    busyRetry: TURSO_BUSY_RETRY,
  }

  constructor(private readonly counted: CountedClient) {}

  /** Requests this driver's client has issued — the round-trip measurement. */
  get roundTrips(): CountedClient['roundTrips'] {
    return this.counted.roundTrips
  }

  classify(error: unknown): FailureClass {
    return classifyLibsqlFailure(error)
  }

  async open(_lane: Lane): Promise<DriverSession> {
    // No connection to acquire: the libsql client multiplexes over HTTP, so a
    // "session" is a handle onto it. `open` costs no round trip, which is why
    // the numbers in the results document are all attributable to statements.
    return new LibsqlSession(this.counted.client)
  }

  client(
    route: Parameters<StoreDriver['client']>[0],
    routeBatch: Parameters<StoreDriver['client']>[1],
  ): QueryClient {
    return queryClientOver(route, routeBatch)
  }

  async close(): Promise<void> {
    this.counted.client.close()
  }
}

/** A driver with no retry, for the arm that has to SEE the busy error rather than absorb it. */
export function withoutBusyRetry(driver: LibsqlSpikeDriver): DriverLimits {
  return { writeBudgetMs: driver.limits.writeBudgetMs, busyRetry: NO_BUSY_RETRY }
}
