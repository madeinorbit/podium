/**
 * The bun:sqlite implementation of {@link StoreDriver} [POD-3248].
 *
 * The engine is synchronous and in-process, so this driver adds no concurrency
 * of its own: it hands out ONE session at a time on the shared connection and
 * lets the scheduler's size-one queue be the thing that serialises. That is
 * deliberate — SQLite's busy wait is synchronous, so a second connection waiting
 * for the write lock would block the very loop the first connection's `await`
 * needs (spec §2.8). Serialisation is done by whoever hands out the connection.
 *
 * The one place a second connection IS correct is {@link openReader}: a WAL
 * reader does not wait for the writer, so the committed-view read
 * (`store.outsideTransaction`) gets its own handle instead of deadlocking on the
 * queue. It is supplied by the caller precisely because it needs WAL and a real
 * file, which not every caller has.
 */

import type { SqlDatabase, SqlStatement } from '@podium/runtime/sqlite'
import type {
  DriverSession,
  Lane,
  LanePolicy,
  QueryClient,
  Statement,
  StatementResult,
  StatementRouter,
  StoreDriver,
} from './driver'
import { queryClientOver } from './driver'

export interface BunDriverOptions {
  /** The shared connection. The scheduler's queue owns it. */
  database: SqlDatabase
  /**
   * Opens a SECOND, read-only connection to the same database for the
   * committed-view read. Omit it and `outsideTransaction` refuses from inside a
   * body rather than deadlocking.
   */
  openReader?: () => SqlDatabase
  /** Called once when the driver closes, after the connections are closed. */
  onClose?: () => void
}

/**
 * Reads take the write slot: with one connection there is no second lane, and a
 * read outside a transaction waiting behind an open body is exactly today's
 * behaviour.
 */
const BUN_LANES: LanePolicy = { readConcurrency: 0 }

export function createBunSqliteDriver(options: BunDriverOptions): StoreDriver<QueryClient> {
  const readers: SqlDatabase[] = []
  let closed = false
  return {
    kind: 'bun-sqlite',
    lanes: BUN_LANES,
    async open(lane) {
      if (closed) throw new Error('bun-sqlite driver is closed')
      return session(options.database, lane === 'read' ? 'shared-read' : 'owner')
    },
    ...(options.openReader
      ? {
          async openReader(): Promise<DriverSession> {
            if (closed) throw new Error('bun-sqlite driver is closed')
            const handle = (options.openReader as () => SqlDatabase)()
            readers.push(handle)
            return session(handle, 'detached-reader', () => {
              handle.close()
              const at = readers.indexOf(handle)
              if (at >= 0) readers.splice(at, 1)
            })
          },
        }
      : {}),
    client(route: StatementRouter): QueryClient {
      return queryClientOver(route)
    },
    async close() {
      if (closed) return
      closed = true
      for (const handle of readers.splice(0)) handle.close()
      options.database.close()
      options.onClose?.()
    },
  }
}

type SessionRole = 'owner' | 'shared-read' | 'detached-reader'

function session(db: SqlDatabase, role: SessionRole, onClose?: () => void): DriverSession {
  /**
   * One prepared statement per distinct SQL text, per connection. bun:sqlite
   * makes `prepare` cheap but not free, and the repositories reuse a small,
   * fixed set of texts — the cache is what keeps a converted repository from
   * being slower than the raw one it replaced. A dynamic `IN` list is the case
   * that would defeat it, which is why the Stage A checklist asks about it.
   */
  const prepared = new Map<string, SqlStatement>()
  const statement = (sql: string): SqlStatement => {
    const hit = prepared.get(sql)
    if (hit) return hit
    const made = db.prepare(sql)
    prepared.set(sql, made)
    return made
  }
  let closed = false
  // Whether `begin` actually opened a transaction on this connection. `commit`
  // and `rollback` are no-ops when it did not, so the scheduler can drive the
  // same begin/commit shape on every lane and let the driver decide which lanes
  // need a transaction at all.
  let open = false
  const live = () => {
    if (closed) throw new Error('driver session is closed')
  }
  return {
    async execute(request: Statement): Promise<StatementResult> {
      live()
      const st = statement(request.sql)
      const params = [...request.params]
      if (request.method === 'run') return { rows: [], run: st.run(...params) }
      if (request.method === 'get') {
        const row = st.get(...params)
        return { rows: row === undefined ? [] : [row] }
      }
      return { rows: st.all(...params) }
    },
    async begin(lane: Lane) {
      live()
      // A read lane opens no transaction: the queue already gives it a snapshot
      // no writer can move under it, and the detached reader is read-only by
      // construction. `exclusive` opens nothing by contract.
      if (lane !== 'write') return
      if (role !== 'owner') throw new Error(`cannot write on a ${role} session`)
      db.exec('BEGIN IMMEDIATE')
      open = true
    },
    async commit() {
      live()
      if (!open) return
      open = false
      db.exec('COMMIT')
    },
    async rollback() {
      live()
      if (!open) return
      open = false
      db.exec('ROLLBACK')
    },
    async enterSavepoint(name) {
      live()
      db.exec(`SAVEPOINT ${name}`)
    },
    async releaseSavepoint(name) {
      live()
      db.exec(`RELEASE SAVEPOINT ${name}`)
    },
    async rollbackToSavepoint(name) {
      live()
      db.exec(`ROLLBACK TO SAVEPOINT ${name}`)
    },
    async close() {
      if (closed) return
      closed = true
      prepared.clear()
      onClose?.()
    },
  }
}
