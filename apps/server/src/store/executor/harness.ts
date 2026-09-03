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
import type { DriverSession, Lane, QueryClient, StoreDriver } from './driver'
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
    client: (route) => inner.client(route),
    close: () => inner.close(),
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
