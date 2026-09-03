/**
 * The deterministic interleaving harness [POD-3248, spec §5.1].
 *
 * The scheduler's guarantees are all about what CANNOT happen between two
 * awaits, and a test that only exercises the happy path never opens that gap.
 * So the bodies here park on barriers the test releases by hand: the ordering
 * under test is chosen by the test, not by the loop, which is what makes these
 * tests deterministic rather than usually right.
 *
 * The statement log is the other half. "No interleaved BEGIN" is not observable
 * from results — two transactions that interleave still return the right rows
 * most of the time — so the driver session is wrapped and every transaction
 * boundary and statement is recorded in order, tagged with its session.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { createBunSqliteDriver } from './bun-driver'
import type {
  DriverLimits,
  DriverSession,
  FailureClass,
  Lane,
  QueryClient,
  Statement,
  StoreDriver,
} from './driver'
import { NO_BUSY_RETRY, queryClientOver, UNBOUNDED_WRITE_BUDGET_MS } from './driver'
import { createStoreExecutor, type RootStoreExecutor, type StoreExecutorOptions } from './executor'

export interface Barrier {
  /** Park here until the test releases the barrier. */
  wait(): Promise<void>
  /** Let everyone parked through. Idempotent. */
  release(): void
  /** Resolves once someone has parked on it. */
  reached(): Promise<void>
}

export function barrier(): Barrier {
  let releaseAll: () => void = () => undefined
  const open = new Promise<void>((resolve) => {
    releaseAll = resolve
  })
  let announceArrival: () => void = () => undefined
  const arrived = new Promise<void>((resolve) => {
    announceArrival = resolve
  })
  return {
    wait() {
      announceArrival()
      return open
    },
    release() {
      releaseAll()
    },
    reached() {
      return arrived
    },
  }
}

/** Let every already-queued microtask run. */
export async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

export interface StatementLog {
  readonly entries: readonly string[]
  /** Only the transaction boundaries, in order. */
  boundaries(): string[]
  clear(): void
}

function recordingDriver(
  inner: StoreDriver<QueryClient>,
  entries: string[],
): StoreDriver<QueryClient> {
  let nextSessionId = 1
  const wrap = (session: DriverSession, tag: string): DriverSession => {
    const note = (what: string) => entries.push(`${tag}:${what}`)
    return {
      async execute(statement) {
        note(statement.sql)
        return session.execute(statement)
      },
      async executeBatch(statements) {
        // ONE entry, not one per statement: whether a batch reached the driver
        // as a single call is the whole question, and the individual SQL is
        // visible in the results.
        note(`BATCH[${statements.length}]`)
        return session.executeBatch(statements)
      },
      async begin(lane: Lane) {
        if (lane === 'write') note('BEGIN IMMEDIATE')
        return session.begin(lane)
      },
      async commit() {
        note('COMMIT')
        return session.commit()
      },
      async rollback() {
        note('ROLLBACK')
        return session.rollback()
      },
      async enterSavepoint(name) {
        note(`SAVEPOINT ${name}`)
        return session.enterSavepoint(name)
      },
      async releaseSavepoint(name) {
        note(`RELEASE ${name}`)
        return session.releaseSavepoint(name)
      },
      async rollbackToSavepoint(name) {
        note(`ROLLBACK TO ${name}`)
        return session.rollbackToSavepoint(name)
      },
      close: () => session.close(),
    }
  }
  const openReader = inner.openReader
  return {
    kind: inner.kind,
    lanes: inner.lanes,
    limits: inner.limits,
    ...(inner.classify ? { classify: (error: unknown) => inner.classify?.(error) ?? 'fatal' } : {}),
    async open(lane) {
      return wrap(await inner.open(lane), `s${nextSessionId++}`)
    },
    // Mirrored, not always defined: whether the driver HAS a reader connection
    // is what `outsideTransaction` branches on, so the wrapper must not invent
    // one.
    ...(openReader
      ? {
          async openReader(): Promise<DriverSession> {
            return wrap(await openReader.call(inner), `r${nextSessionId++}`)
          },
        }
      : {}),
    client: (route, routeBatch) => inner.client(route, routeBatch),
    close: () => inner.close(),
  }
}

/**
 * A FULLY ASYNCHRONOUS driver with a hook on every operation, for the failures
 * bun:sqlite cannot produce [POD-3310].
 *
 * bun:sqlite's boundaries are synchronous and infallible, so no test over it can
 * open the gap the remote driver has at every one of them: `open` is a network
 * call, `close` returns a connection to a pool, `commit` is held on the server,
 * and any of them can reject or take arbitrarily long. Each hook may park (the
 * test releases it), reject (the operation fails), or be absent (the operation
 * succeeds immediately).
 */
export interface AsyncDriverHooks {
  open?(lane: Lane, attempt: number): Promise<void>
  executeBatch?(statements: readonly Statement[]): Promise<void>
  begin?(lane: Lane): Promise<void>
  execute?(statement: Statement): Promise<void>
  commit?(attempt: number): Promise<void>
  rollback?(): Promise<void>
  close?(attempt: number): Promise<void>
  enterSavepoint?(name: string): Promise<void>
  releaseSavepoint?(name: string): Promise<void>
  rollbackToSavepoint?(name: string): Promise<void>
}

export interface AsyncFakeDriver extends StoreDriver<QueryClient> {
  /** Every operation, in order. */
  readonly calls: readonly string[]
  /** Sessions opened, and sessions whose `close` completed. */
  readonly opens: number
  readonly closes: number
}

export function asyncFakeDriver(
  options: {
    hooks?: AsyncDriverHooks
    readConcurrency?: number
    limits?: DriverLimits
    classify?: (error: unknown) => FailureClass
  } = {},
): AsyncFakeDriver {
  const hooks = options.hooks ?? {}
  const calls: string[] = []
  let opens = 0
  let closes = 0
  // Driver-wide, not per session: the hook's `attempt` counts operations across
  // the whole driver, so "fail the first close only" means what it says.
  let closeAttempts = 0
  let commitAttempts = 0
  const run = { changes: 0, lastInsertRowid: 0 }
  const makeSession = (id: number): DriverSession => {
    // Tagged per session, like `recordingDriver`: which session a statement
    // reached is the whole question for a leaked scope, and results cannot
    // show it.
    const tag = `s${id}`
    return {
      async execute(statement) {
        calls.push(`${tag}:execute:${statement.sql}`)
        await hooks.execute?.(statement)
        return statement.method === 'run' ? { rows: [], run } : { rows: [] }
      },
      async executeBatch(statements) {
        calls.push(`${tag}:batch[${statements.length}]`)
        await hooks.executeBatch?.(statements)
        return statements.map((statement) =>
          statement.method === 'run' ? { rows: [], run } : { rows: [] },
        )
      },
      async begin(lane) {
        calls.push(`${tag}:begin:${lane}`)
        await hooks.begin?.(lane)
      },
      async commit() {
        calls.push(`${tag}:commit`)
        await hooks.commit?.(++commitAttempts)
      },
      async rollback() {
        calls.push(`${tag}:rollback`)
        await hooks.rollback?.()
      },
      async enterSavepoint(name) {
        calls.push(`${tag}:enter:${name}`)
        await hooks.enterSavepoint?.(name)
      },
      async releaseSavepoint(name) {
        calls.push(`${tag}:release:${name}`)
        await hooks.releaseSavepoint?.(name)
      },
      async rollbackToSavepoint(name) {
        calls.push(`${tag}:rollbackTo:${name}`)
        await hooks.rollbackToSavepoint?.(name)
      },
      async close() {
        calls.push(`${tag}:close`)
        await hooks.close?.(++closeAttempts)
        closes++
      },
    }
  }
  return {
    kind: 'async-fake',
    lanes: { readConcurrency: options.readConcurrency ?? 0 },
    limits: options.limits ?? { writeBudgetMs: UNBOUNDED_WRITE_BUDGET_MS, busyRetry: NO_BUSY_RETRY },
    ...(options.classify ? { classify: options.classify } : {}),
    async open(lane) {
      const attempt = ++opens
      calls.push(`open:${lane}`)
      await hooks.open?.(lane, attempt)
      return makeSession(attempt)
    },
    client: (route, routeBatch) => queryClientOver(route, routeBatch),
    async close() {
      calls.push('driver-close')
    },
    get calls() {
      return calls
    },
    get opens() {
      return opens
    },
    get closes() {
      return closes
    },
  }
}

export interface Harness {
  executor: RootStoreExecutor<QueryClient>
  db: QueryClient
  log: StatementLog
  /** The raw handle, for setup and for assertions about committed rows. */
  raw: SqlDatabase
  close(): Promise<void>
}

export interface HarnessOptions
  extends Omit<StoreExecutorOptions<QueryClient>, 'driver' | 'legacy'> {
  /** Extra DDL run before the executor is built. */
  schema?: string
  /** Leave the reader connection out, to test what a driver without one does. */
  withoutReader?: boolean
}

const DEFAULT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`

/**
 * A real bun:sqlite database on a real file, in WAL — not `:memory:`, because
 * the committed-view read needs a SECOND connection to the same database and
 * WAL is what lets it read while the writer holds the write lock.
 */
export function openHarness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'pod-3248-'))
  const path = join(dir, 'harness.db')
  const raw = openDatabase(path)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec(options.schema ?? DEFAULT_SCHEMA)
  const entries: string[] = []
  const driver = recordingDriver(
    createBunSqliteDriver({
      database: raw,
      ...(options.withoutReader
        ? {}
        : { openReader: () => openDatabase(path, { readOnly: true }) }),
      onClose: () => rmSync(dir, { recursive: true, force: true }),
    }),
    entries,
  )
  const executor = createStoreExecutor<QueryClient>({
    driver,
    ...(options.watchdog ? { watchdog: options.watchdog } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.effectSink ? { effectSink: options.effectSink } : {}),
    ...(options.onUnhealthy ? { onUnhealthy: options.onUnhealthy } : {}),
    ...(options.onReportFailure ? { onReportFailure: options.onReportFailure } : {}),
  })
  const log: StatementLog = {
    entries,
    boundaries: () =>
      entries.filter((entry) =>
        /:(BEGIN IMMEDIATE|COMMIT|ROLLBACK|SAVEPOINT |RELEASE |ROLLBACK TO )/.test(entry),
      ),
    clear: () => {
      entries.length = 0
    },
  }
  return {
    executor,
    db: executor.drizzle,
    log,
    raw,
    close: () => executor.close(),
  }
}
