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
  BatchRouter,
  DriverLimits,
  DriverSession,
  Lane,
  LanePolicy,
  QueryClient,
  Statement,
  StatementResult,
  StatementRouter,
  StoreDriver,
} from './driver'
import { NO_BUSY_RETRY, queryClientOver, UNBOUNDED_WRITE_BUDGET_MS } from './driver'

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

/**
 * In-process and single-writer by construction: no server ends a transaction
 * under us, and the scheduler's size-one queue means a second writer never
 * reaches the engine, so there is no busy error to retry. Both numbers are
 * DECLARED rather than assumed by the scheduler, because the remote driver's
 * are neither (spec §6 rule 7: about 9 s and a real busy shape on Turso).
 */
const BUN_LIMITS: DriverLimits = {
  writeBudgetMs: UNBOUNDED_WRITE_BUDGET_MS,
  busyRetry: NO_BUSY_RETRY,
}

export function createBunSqliteDriver(options: BunDriverOptions): StoreDriver<QueryClient> {
  const readers: SqlDatabase[] = []
  /**
   * ONE prepared-statement cache per CONNECTION, owned here and cleared only
   * when that connection closes.
   *
   * It used to live inside `session()`, which is built fresh for every scheduler
   * lease over the same connection — so every root operation re-prepared every
   * statement it used, which is the opposite of what the cache is for and would
   * make a converted repository slower than the raw one it replaced.
   */
  const caches = new Map<SqlDatabase, Map<string, SqlStatement>>()
  const cacheFor = (db: SqlDatabase): Map<string, SqlStatement> => {
    const existing = caches.get(db)
    if (existing) return existing
    const made = new Map<string, SqlStatement>()
    caches.set(db, made)
    return made
  }
  let closed = false
  return {
    kind: 'bun-sqlite',
    lanes: BUN_LANES,
    limits: BUN_LIMITS,
    async open(lane) {
      if (closed) throw new Error('bun-sqlite driver is closed')
      return session(
        options.database,
        lane === 'read' ? 'shared-read' : 'owner',
        cacheFor(options.database),
      )
    },
    ...(options.openReader
      ? {
          async openReader(): Promise<DriverSession> {
            if (closed) throw new Error('bun-sqlite driver is closed')
            const handle = (options.openReader as () => SqlDatabase)()
            readers.push(handle)
            return session(handle, 'detached-reader', cacheFor(handle), () => {
              handle.close()
              caches.delete(handle)
              const at = readers.indexOf(handle)
              if (at >= 0) readers.splice(at, 1)
            })
          },
        }
      : {}),
    client(route: StatementRouter, routeBatch: BatchRouter): QueryClient {
      return queryClientOver(route, routeBatch)
    },
    async close() {
      if (closed) return
      closed = true
      for (const handle of readers.splice(0)) handle.close()
      options.database.close()
      caches.clear()
      options.onClose?.()
    },
  }
}

type SessionRole = 'owner' | 'shared-read' | 'detached-reader'

function session(
  db: SqlDatabase,
  role: SessionRole,
  /**
   * One prepared statement per distinct SQL text, per connection — owned by the
   * DRIVER and passed in, because a lease is not a connection. bun:sqlite makes
   * `prepare` cheap but not free, and the repositories reuse a small, fixed set
   * of texts. A dynamic `IN` list is the case that would defeat it, which is why
   * the Stage A checklist asks about it.
   */
  prepared: Map<string, SqlStatement>,
  onClose?: () => void,
): DriverSession {
  const statement = (sql: string): SqlStatement => {
    const hit = prepared.get(sql)
    if (hit) return hit
    const made = db.prepare(sql)
    prepared.set(sql, made)
    return made
  }
  let closed = false
  /**
   * Names the savepoint a batch inside an open transaction takes as its own
   * boundary. Per session and monotonic, so it can never collide with the
   * executor's `podium_sp_<depth>` frames or with another batch's.
   */
  let nextBatchBoundary = 1
  // Whether `begin` actually opened a transaction on this connection. `commit`
  // and `rollback` are no-ops when it did not, so the scheduler can drive the
  // same begin/commit shape on every lane and let the driver decide which lanes
  // need a transaction at all.
  let open = false
  const live = () => {
    if (closed) throw new Error('driver session is closed')
  }
  const runOne = (request: Statement): StatementResult => {
    const st = statement(request.sql)
    const params = [...request.params]
    if (request.method === 'run') return { rows: [], run: st.run(...params) }
    if (request.method === 'get') {
      const row = st.get(...params)
      return { rows: row === undefined ? [] : [row] }
    }
    return { rows: st.all(...params) }
  }
  return {
    async execute(request: Statement): Promise<StatementResult> {
      live()
      return runOne(request)
    },
    async executeBatch(requests: readonly Statement[]): Promise<readonly StatementResult[]> {
      live()
      if (requests.length === 0) return []
      /**
       * ATOMIC, like the remote `client.batch` this stands in for: all of it
       * applies or none of it does. A read-only session has nothing to make
       * atomic; a writer gets a boundary either way.
       *
       * THE ENCLOSING TRANSACTION IS NOT THE BATCH'S BOUNDARY. It used to be
       * treated as one, so inside `transact` the statements ran in a bare loop:
       * a caller that CAUGHT the batch's error and let the outer body commit
       * committed the prefix that had already applied, which is precisely what
       * the contract says cannot happen. So an open transaction gets a
       * SAVEPOINT of its own, rolled back and released on failure, leaving the
       * transaction exactly as the batch found it.
       */
      const implicit = !open && role === 'owner'
      const boundary = open && role === 'owner' ? `podium_batch_${nextBatchBoundary++}` : undefined
      if (implicit) db.exec('BEGIN IMMEDIATE')
      else if (boundary) db.exec(`SAVEPOINT ${boundary}`)
      try {
        const results: StatementResult[] = []
        for (const request of requests) results.push(runOne(request))
        if (implicit) db.exec('COMMIT')
        else if (boundary) db.exec(`RELEASE SAVEPOINT ${boundary}`)
        return results
      } catch (error) {
        if (implicit) db.exec('ROLLBACK')
        else if (boundary) {
          db.exec(`ROLLBACK TO SAVEPOINT ${boundary}`)
          db.exec(`RELEASE SAVEPOINT ${boundary}`)
        }
        throw error
      }
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
      // The cache belongs to the connection, not to this lease: clearing it
      // here is what made it useless.
      onClose?.()
    },
  }
}
