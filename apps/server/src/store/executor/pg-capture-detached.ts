/**
 * A POSTGRES STORE'S CHANGE CAPTURE BEFORE IT IS ATTACHED [POD-6994, POD-6958 design 2.5].
 *
 * WHY. On SQLite a store captures nothing until its change capture is attached
 * (`StoreDatabase.attachChangeLog`): the boot drops the capture triggers before it
 * migrates and repairs, and installs them only once the boot is done; a test store
 * (`changeCapture: 'whenLogAttaches'`) installs them only when a change log attaches. On
 * Postgres capture is part of every write statement on a source table (`captureWrite`,
 * `sync/capture-pg.ts`) and cannot be switched off, and the baseline's deferred guard
 * (`sync_capture.undrained`) refuses a commit that leaves a capture row undrained.
 *
 * WHAT. {@link captureDetachedDriver} wraps the Postgres driver. Until {@link
 * CaptureDetachedDriver.attach}, a write-lane session that ran at least one statement
 * sends `DELETE FROM sync_capture` just before its COMMIT, and a write outside any
 * transaction carries the same DELETE as the last statement of its own unit: the writes
 * commit, and what they captured is dropped, the outcome SQLite has by never capturing.
 * After the attach nothing is added, so an undrained commit is refused by the deferred
 * guard exactly as before, and a write costs no extra statement.
 *
 * WHY THE DELETE TAKES ONLY THE TRANSACTION'S OWN ROWS. The drain
 * (`SyncRepository.drainCapture`) takes rows off the table, and the guard refuses a
 * commit that leaves any, so no committed transaction ever leaves a row in
 * `sync_capture`. A write transaction runs at READ COMMITTED, where a statement sees
 * committed rows and its own transaction's (savepoints included), never another
 * transaction's uncommitted ones. So the rows the DELETE sees are exactly this
 * transaction's, and a concurrent writer's capture is untouched
 * (`pg-capture-detached.test.ts`).
 *
 * WHERE IT RUNS. On the driver's session, below the statement probe
 * (`instrumentDriver`), as SQLite's trigger installation and its PRAGMAs run outside any
 * repository statement. A statement pin therefore counts the same on both engines; the
 * cost (one statement per write transaction, before the attach only) is pinned by this
 * file's own test at the driver: one statement per write unit before the attach (in a
 * transaction a statement before COMMIT; outside one a statement of the same pipelined
 * unit), none after it, none for a read.
 */

import type { DriverSession, QueryClient, Statement, StatementResult, StoreDriver } from './driver'

/** The statement that drops the transaction's own capture rows. */
export const DROP_OWN_CAPTURE: Statement = Object.freeze({
  sql: 'DELETE FROM sync_capture',
  params: [],
  method: 'run',
  intent: 'write',
})

/** A driver whose write transactions drop their capture until {@link attach}. */
export interface CaptureDetachedDriver {
  readonly driver: StoreDriver<QueryClient>
  /** From now on a write transaction keeps its capture, for its commit to drain. Idempotent. */
  attach(): void
  /** Whether {@link attach} has been called. */
  readonly attached: boolean
}

/** Wrap `driver` so its write transactions drop their capture until attached. */
export function captureDetachedDriver(driver: StoreDriver<QueryClient>): CaptureDetachedDriver {
  let attached = false
  const wrap = (session: DriverSession): DriverSession => {
    // Whether a transaction is open on the session, and whether it ran a statement:
    // one that ran none has captured nothing, and a DELETE would be its first
    // statement (and its BEGIN's).
    let open = false
    let ran = false
    /**
     * A write outside any transaction is its own unit: the driver pipelines it as
     * `BEGIN; [lock;] statements; COMMIT` (or a lone global statement autocommits). Before
     * the attach the DELETE joins that unit as its last statement, so the unit still
     * costs one round trip and commits nothing it captured.
     */
    const atRoot = (statements: readonly Statement[]): boolean =>
      !open && !attached && statements.some((statement) => statement.intent === 'write')
    return {
      async execute(statement) {
        if (atRoot([statement])) {
          const [result] = await session.executeBatch([statement, DROP_OWN_CAPTURE])
          return result as StatementResult
        }
        ran = true
        return await session.execute(statement)
      },
      async executeBatch(statements) {
        if (atRoot(statements)) {
          const results = await session.executeBatch([...statements, DROP_OWN_CAPTURE])
          return results.slice(0, statements.length)
        }
        ran = true
        return await session.executeBatch(statements)
      },
      async begin(lane) {
        await session.begin(lane)
        open = true
        ran = false
      },
      async commit() {
        if (ran && !attached) await session.execute(DROP_OWN_CAPTURE)
        open = false
        ran = false
        await session.commit()
      },
      async rollback() {
        open = false
        ran = false
        await session.rollback()
      },
      enterSavepoint: async (name) => await session.enterSavepoint(name),
      releaseSavepoint: async (name) => await session.releaseSavepoint(name),
      rollbackToSavepoint: async (name) => await session.rollbackToSavepoint(name),
      close: async () => await session.close(),
    }
  }
  const reader = driver.openReader?.bind(driver)
  const wrapped: StoreDriver<QueryClient> = {
    kind: driver.kind,
    ...(driver.dialect ? { dialect: driver.dialect } : {}),
    lanes: driver.lanes,
    limits: driver.limits,
    ...(driver.classify ? { classify: driver.classify.bind(driver) } : {}),
    async open(lane) {
      const session = await driver.open(lane)
      // A read lease writes nothing; its session passes through.
      return lane === 'read' ? session : wrap(session)
    },
    // The committed-view reader refuses writes.
    ...(reader ? { openReader: reader } : {}),
    client: (route, routeBatch) => driver.client(route, routeBatch),
    close: async () => await driver.close(),
  }
  return {
    driver: wrapped,
    attach() {
      attached = true
    },
    get attached() {
      return attached
    },
  }
}
