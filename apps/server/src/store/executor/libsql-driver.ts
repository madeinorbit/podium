/**
 * The libsql remote implementation of {@link StoreDriver} [POD-3272].
 *
 * Written against the executor port issue 0.6 settled, using the facts the
 * spike (POD-3251) and the sync-append proof (POD-3250) measured:
 *
 *   - `@libsql/client/web` only; the default entry pulls a native addon.
 *   - hrana over HTTP is the only transport; a WebSocket upgrade is refused.
 *   - `begin` goes through `client.transaction(mode)` and NEVER a raw BEGIN:
 *     a raw `BEGIN IMMEDIATE` returns success and does nothing, because each
 *     `execute()` is its own stream.
 *   - one in-process write lane; reads may run concurrently (the client's
 *     default of 20).
 *   - a batch inside an open transaction wraps itself in a savepoint, because
 *     a raw `tx.batch` is not atomic on this engine.
 *   - `classify` unwraps `.cause` transitively: drizzle wraps driver errors
 *     in `DrizzleQueryError`, and a busy retry that inspects the wrapper
 *     silently never fires.
 */

import type { Client, InValue, ResultSet, Transaction } from '@podium/runtime/libsql'
import { attachLaneIntentAudit } from './lane-intent-audit'
import type {
  BatchRouter,
  DriverLimits,
  DriverSession,
  FailureClass,
  Lane,
  LanePolicy,
  QueryClient,
  SqlParam,
  Statement,
  StatementResult,
  StatementRouter,
  StoreDriver,
} from './driver'
import { queryClientOver } from './driver'
import { createStoreExecutor, type RootStoreExecutor, type StoreExecutorOptions } from './executor'
import {
  installQueryAttributionProbe,
  instrumentDriver,
  statementProbeHubFor,
} from './statement-probe'

/**
 * The measured server-side budget for an interactive transaction.
 *
 * IT BOUNDS THE GAP BETWEEN STATEMENTS, NOT THE TRANSACTION'S DURATION
 * (POD-3250 proof 9, POD-3251 gate 3, spec §6 rule 7). Alive at an 8 s gap,
 * dead at 10. Declared here so the scheduler's watchdog sits below it and
 * measures the same quantity.
 */
export const TURSO_WRITE_BUDGET_MS = 9_000

/**
 * Bounded, above the transaction, acquisition only. A network blip closes a
 * remote transaction permanently (`TRANSACTION_CLOSED`), so retrying anything
 * whose body has begun risks applying work twice.
 */
export const TURSO_BUSY_RETRY = {
  attempts: 3,
  initialDelayMs: 50,
  maxDelayMs: 500,
} as const

/** One write lane; reads bounded by the client's concurrent-request budget. */
export const LIBSQL_LANES: LanePolicy = { readConcurrency: 20 }

export function unwrapCause(error: unknown): unknown {
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
 * `SQLITE_BUSY` is the only retryable class. On Turso it arrives as a write
 * conflict OR as the idle reaper's "interactive transaction was rolled back
 * because the stream was idle for too long". Both are safe to retry AT
 * ACQUISITION. `TRANSACTION_CLOSED` means the work is already lost — fatal.
 */
export function classifyLibsqlFailure(error: unknown): FailureClass {
  const original = unwrapCause(error)
  const code = (original as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.toUpperCase().includes('SQLITE_BUSY')) return 'busy'
  const message = original instanceof Error ? original.message : String(original)
  return /SQLITE_BUSY|database is locked/i.test(message) ? 'busy' : 'fatal'
}

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

type Issuer = Pick<Client, 'execute' | 'batch'>

class LibsqlSession implements DriverSession {
  private tx: Transaction | undefined
  private savepointSerial = 0
  private closed = false

  constructor(
    private readonly client: Client,
    private readonly role: 'owner' | 'reader',
  ) {}

  private live(): void {
    if (this.closed) throw new Error('driver session is closed')
  }

  private get issuer(): Issuer {
    return this.tx ?? this.client
  }

  private assertMayWrite(request: Statement): void {
    if (request.intent !== 'write' || this.role === 'owner') return
    throw new Error(`cannot write on a ${this.role} session: ${request.sql}`)
  }

  async execute(statement: Statement): Promise<StatementResult> {
    this.live()
    this.assertMayWrite(statement)
    const result = await this.issuer.execute({
      sql: statement.sql,
      args: toArgs(statement.params),
    })
    return decode(statement, result)
  }

  async executeBatch(statements: readonly Statement[]): Promise<readonly StatementResult[]> {
    this.live()
    if (statements.length === 0) return []
    for (const statement of statements) this.assertMayWrite(statement)
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
    this.live()
    if (lane === 'exclusive') return
    if (lane === 'write' && this.role !== 'owner') {
      throw new Error(`cannot write on a ${this.role} session`)
    }
    // The driver IS the port's implementation, so this is the one call site the
    // transaction-port rule exists to require rather than forbid. This file is
    // named in the lint's TRANSACTION_OPENERS (spec §6 rule 22).
    this.tx = await this.client.transaction(lane === 'write' ? 'write' : 'read')
  }

  async commit(): Promise<void> {
    this.live()
    await this.tx?.commit()
    this.tx = undefined
  }

  async rollback(): Promise<void> {
    this.live()
    await this.tx?.rollback()
    this.tx = undefined
  }

  async enterSavepoint(name: string): Promise<void> {
    this.live()
    await this.issuer.execute(`SAVEPOINT ${quoteSavepoint(name)}`)
  }

  async releaseSavepoint(name: string): Promise<void> {
    this.live()
    await this.issuer.execute(`RELEASE ${quoteSavepoint(name)}`)
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    this.live()
    await this.issuer.execute(`ROLLBACK TO ${quoteSavepoint(name)}`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.tx !== undefined) await this.rollback()
  }
}

function quoteSavepoint(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unusable savepoint name: ${name}`)
  return `"${name}"`
}

export interface LibsqlDriverOptions {
  /** Writer. Every write lane and exclusive operation uses this client. */
  client: Client
  /**
   * A SECOND client for committed-view reads (`outsideTransaction`) and the
   * concurrent read lane. Omit it and `outsideTransaction` refuses from inside
   * a body rather than sharing the write client's stream.
   */
  reader?: Client
  onClose?: () => void
}

export function createLibsqlDriver(options: LibsqlDriverOptions): StoreDriver<QueryClient> {
  let closed = false
  return {
    kind: 'libsql-remote',
    lanes: LIBSQL_LANES,
    limits: {
      writeBudgetMs: TURSO_WRITE_BUDGET_MS,
      busyRetry: TURSO_BUSY_RETRY,
    },
    classify: classifyLibsqlFailure,
    async open(lane) {
      if (closed) throw new Error('libsql-remote driver is closed')
      if (lane === 'read' && options.reader !== undefined) {
        return new LibsqlSession(options.reader, 'reader')
      }
      return new LibsqlSession(options.client, 'owner')
    },
    ...(options.reader
      ? {
          async openReader(): Promise<DriverSession> {
            if (closed) throw new Error('libsql-remote driver is closed')
            return new LibsqlSession(options.reader as Client, 'reader')
          },
        }
      : {}),
    client(route: StatementRouter, routeBatch: BatchRouter): QueryClient {
      return queryClientOver(route, routeBatch)
    },
    async close() {
      if (closed) return
      closed = true
      options.client.close()
      options.reader?.close()
      options.onClose?.()
    },
  }
}

export interface LibsqlStoreExecutorOptions
  extends Omit<StoreExecutorOptions<QueryClient>, 'driver'> {
  client: Client
  reader?: Client
  onClose?: () => void
}

/**
 * The libsql composition root: one driver and executor factory for a hosted
 * SessionStore. Attribution wraps execute/batch at the same seam as bun.
 */
export function createLibsqlStoreExecutor(
  options: LibsqlStoreExecutorOptions,
): RootStoreExecutor<QueryClient> {
  const { client, reader, onClose, ...executor } = options
  const probes = statementProbeHubFor(client)
  installQueryAttributionProbe(probes)
  if (process.env.PODIUM_STATEMENT_INTENT_REPORT) attachLaneIntentAudit(probes)
  return createStoreExecutor<QueryClient>({
    driver: instrumentDriver(
      createLibsqlDriver({
        client,
        ...(reader ? { reader } : {}),
        ...(onClose ? { onClose } : {}),
      }),
      probes,
    ),
    ...executor,
  })
}
