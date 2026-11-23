/**
 * THE SYNC WORKER'S READ SESSION [POD-6991, POD-6958 design 2.9].
 *
 * One job reads inside ONE snapshot: the feed's head, the change pages, the records
 * and every sharing-rule read all see the same committed state. The session is a
 * store executor whose every statement runs inside one read-only transaction on one
 * connection, opened on the store's own engine, which its location names
 * (`storeEngineFor`):
 *
 * - SQLite (a file path): a read-only WAL connection of its own, `BEGIN`. The first
 *   read fixes the snapshot; the executor is the bun executor over that connection,
 *   exactly as before this session existed.
 * - Postgres (a `postgres://` URL): one pooled connection in `BEGIN ISOLATION LEVEL
 *   REPEATABLE READ READ ONLY` (`pg-read-session.ts`). The BEGIN goes out with the
 *   first read, which fixes the snapshot, as on SQLite. That module, and postgres.js
 *   with it, loads only for a Postgres location, so a SQLite worker never loads it.
 *
 * Holding the snapshot costs the engine something until `close`: SQLite cannot
 * checkpoint past it, and Postgres's vacuum keeps the row versions it can see. The
 * job's deadline bounds both (`SYNC_JOB_DEADLINE_MS`).
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import type { QueryClient } from '../store/executor/driver'
import type { RootStoreExecutor } from '../store/executor/executor'
import { storeEngineFor } from '../store-database'

export interface WorkerReadSessionOptions {
  /**
   * How long the transaction may wait between two statements, in milliseconds: the
   * job's time left. A transfer waits on its client between pages, and on Postgres an
   * open transaction idle past the role's `idle_in_transaction_session_timeout` is
   * ended by the server; the session raises it to this for its own transaction. SQLite
   * has no such limit.
   */
  readonly idleBudgetMs?: number
}

/** A store executor over one read-only snapshot. */
export interface WorkerReadSession {
  /** Every statement of every repository built over it runs in the snapshot. */
  readonly executor: RootStoreExecutor<QueryClient>
  /** End the snapshot and release the connection. Called once, in a `finally`. */
  close(): Promise<void>
}

/** Open a read session on the store at `location` (a SQLite path or a Postgres URL). */
export async function openWorkerReadSession(
  location: string,
  options: WorkerReadSessionOptions = {},
): Promise<WorkerReadSession> {
  if (storeEngineFor(location) === 'pg') {
    const { openPgReadSession } = await import('./pg-read-session')
    return await openPgReadSession(location, options)
  }
  return openSqliteReadSession(location)
}

/**
 * The SQLite session: its own read-only connection, `BEGIN` deferred, so the first
 * read takes the snapshot. Nothing here reaches the executor's statement probe, as
 * before: `exec` prepares no statement.
 */
function openSqliteReadSession(path: string): WorkerReadSession {
  const db = openDatabase(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN')
  } catch (error) {
    db.close()
    throw error
  }
  const executor = createBunStoreExecutor({ database: db })
  let closed = false
  return {
    executor,
    async close() {
      if (closed) return
      closed = true
      try {
        db.exec('ROLLBACK')
      } finally {
        // The bun driver closes the connection it was given.
        await executor.close()
      }
    },
  }
}
