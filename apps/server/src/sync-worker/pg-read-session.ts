/**
 * THE SYNC WORKER'S READ SESSION ON POSTGRES [POD-6991, POD-6958 design 2.4, 2.9].
 *
 * One connection of a pool of one, reserved for the whole job as the driver's
 * committed-view reader (`openReader`: a session that refuses writes), and in it one
 * transaction, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`. The driver holds that
 * BEGIN until the first statement and sends both in one pipeline; Postgres takes the
 * snapshot at the first read, so, as on SQLite, the first read fixes it and every later
 * read of the job shares it.
 *
 * The executor over it is the store's own (scheduler, query layer, statement probe) on
 * a driver whose every lease is a view of that one session: `begin`, `commit` and
 * `rollback` of a lease do nothing, because the job's transaction is the session's
 * and ends only at `close`. Reads take one slot (`readConcurrency: 0`), so the job's
 * statements run one at a time on the connection, as on SQLite's one handle. No lease
 * can write: a write lane is refused at `open`, a write statement by the reader session,
 * and the transaction itself is READ ONLY.
 *
 * The statement probe's hub is keyed by the pool's driver object, as the SQLite
 * session's is keyed by its database handle, so a test that intercepts the driver's
 * creation can count what the job runs.
 */

import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import * as pgSchema from '../migrations/pg/schema'
import {
  type DriverSession,
  NO_BUSY_RETRY,
  type QueryClient,
  queryClientOver,
  type StoreDriver,
} from '../store/executor/driver'
import { createStoreExecutor } from '../store/executor/executor'
import { createPgStoreDriver, type PgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import type { WorkerReadSession, WorkerReadSessionOptions } from './read-session'

/** The store's Postgres tables: the server schema's twins and the sync tables' twins. */
const PG_STORE_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })

/** Open the job's snapshot session on the Postgres store at `url`. */
export async function openPgReadSession(
  url: string,
  options: WorkerReadSessionOptions = {},
): Promise<WorkerReadSession> {
  // One connection: the job's. No write slot is ever taken; the split asks for none
  // beyond the one the driver requires.
  const pool = createPgStoreDriver({ url, poolSize: 1, writeSlots: 1, readConcurrency: 0 })
  let session: DriverSession
  try {
    session = await pool.openReader()
  } catch (error) {
    await pool.close()
    throw error
  }
  try {
    // Pending: it goes out with the first statement below.
    await session.begin('read')
    if (options.idleBudgetMs !== undefined) {
      // SET takes no snapshot, so the first READ still fixes it. Not a store
      // statement: it runs on the session itself, outside the probe, as SQLite's
      // PRAGMAs and BEGIN run on its handle.
      const ms = Math.max(1, Math.ceil(options.idleBudgetMs))
      await session.execute({
        sql: `SET LOCAL idle_in_transaction_session_timeout = '${ms}ms'`,
        params: [],
        method: 'run',
        intent: 'read',
      })
    }
  } catch (error) {
    await session.close().catch(() => undefined)
    await pool.close()
    throw error
  }
  const snapshot = snapshotDriver(pool, session)
  const executor = createStoreExecutor<QueryClient>({
    driver: instrumentDriver(snapshot, statementProbeHubFor(pool)),
    queryLayer: pgQueryLayer(PG_STORE_TABLES),
    startOpen: true,
  })
  return {
    executor,
    // The driver's close ends the transaction and the pool.
    close: async () => await executor.close(),
  }
}

/**
 * A driver whose every lease is `session`: the executor's root reads, read bodies and
 * savepoints all run in the one transaction the session holds. Closing it rolls that
 * transaction back (the reader session does, on close) and ends the pool.
 */
function snapshotDriver(pool: PgStoreDriver, session: DriverSession): StoreDriver<QueryClient> {
  let closed = false
  const lease: DriverSession = {
    execute: async (statement) => await session.execute(statement),
    executeBatch: async (statements) => await session.executeBatch(statements),
    async begin(lane) {
      if (lane !== 'read') throw new Error(`the sync worker's read session cannot open ${lane}`)
    },
    async commit() {},
    async rollback() {},
    enterSavepoint: async (name) => await session.enterSavepoint(name),
    releaseSavepoint: async (name) => await session.releaseSavepoint(name),
    rollbackToSavepoint: async (name) => await session.rollbackToSavepoint(name),
    async close() {},
  }
  return {
    kind: 'postgres-snapshot',
    dialect: 'pg',
    lanes: { readConcurrency: 0 },
    limits: { writeBudgetMs: pool.limits.writeBudgetMs, busyRetry: NO_BUSY_RETRY },
    async open(lane) {
      if (closed) throw new Error("the sync worker's read session is closed")
      if (lane !== 'read') throw new Error(`the sync worker's read session cannot open ${lane}`)
      return lease
    },
    client: (route, routeBatch) => queryClientOver(route, routeBatch),
    async close() {
      if (closed) return
      closed = true
      try {
        await session.close()
      } finally {
        await pool.close()
      }
    },
  }
}
