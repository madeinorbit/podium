/** Connection setup and migration bracket, owned by the exclusive boot lane. */
import { join, resolve } from 'node:path'
import { stateDir } from '@podium/runtime/config'
import { MACHINE_UPDATE_GRANT_ENV, readMachineUpdateJournal } from '@podium/runtime/machine-update'
import type { DriverSession } from '../store/executor/driver'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

export function configureStoreConnection(db: SqlDatabase): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
}

export function migrateStoreConnection(db: SqlDatabase, path: string): string[] {
  configureStoreConnection(db)
  const runtimeDir = join(stateDir(), 'runtime')
  // Pin the current grant before running SQL; a later executor transition must
  // not attribute this batch to another update. In-memory test stores are not updates.
  const inheritedGrantId = process.env[MACHINE_UPDATE_GRANT_ENV]
  const journal =
    path === ':memory:' || inheritedGrantId ? undefined : readMachineUpdateJournal(runtimeDir)
  const grantId =
    inheritedGrantId ??
    (journal && ['activating', 'restarting'].includes(journal.phase)
      ? journal.grant.grantId
      : undefined)
  const update = path !== ':memory:' && grantId ? { runtimeDir, grantId } : undefined
  // This bracket belongs to this connection, OUTSIDE drizzle's transaction.
  // Inside BEGIN, foreign_keys is a no-op and a rebuild can delete child rows.
  return withMigrationForeignKeysDisabled(db, () =>
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS, {
      dbPath: path === ':memory:' ? undefined : resolve(path),
      update,
    }),
  )
}

export function withMigrationForeignKeysDisabled<T>(db: SqlDatabase, migrate: () => T): T {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    return migrate()
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

export async function checkpointStore(session: DriverSession): Promise<void> {
  await session.execute({
    sql: 'PRAGMA wal_checkpoint(TRUNCATE)',
    params: [],
    method: 'all',
    intent: 'write',
  })
}

/**
 * THE PLANNER'S STATISTICS [POD-6148, server data design §3 rule 3].
 *
 * Without `sqlite_stat1` the planner guesses every table's size and every
 * index's selectivity, so it may seek on a column most rows share (a
 * `deleted_at IS NULL`) instead of the key a query names. The live database
 * had never been analysed. SQLite's guidance for a long-lived connection is
 * `PRAGMA optimize=0x10002` when it opens and plain `PRAGMA optimize`
 * periodically (https://sqlite.org/pragma.html#pragma_optimize); both
 * re-analyse only the tables whose statistics are missing or stale, and
 * `analysis_limit` bounds each ANALYZE to a sample of every index, so a pass
 * costs milliseconds whatever the database size.
 *
 * ON THE EXCLUSIVE LANE, NEVER IN A TRANSACTION. ANALYZE writes
 * `sqlite_stat1`, and statistics written inside a transaction would commit or
 * roll back with whatever that transaction was doing. The caller passes the
 * exclusive lane's session, which `exclusive()` refuses to hand out from
 * inside a transaction scope, and the lane opens no transaction of its own.
 */
export const ANALYSIS_LIMIT = 1000

/** How often a running server refreshes the statistics (SQLite suggests hourly to daily). */
export const PLANNER_STATISTICS_INTERVAL_MS = 60 * 60 * 1000

/**
 * A TABLE ANALYSED WHILE TINY KEEPS NO STATISTICS [POD-6223].
 *
 * Statistics describe the table as it was when analysed, and `PRAGMA optimize`
 * re-analyses a table only once its size has changed tenfold, and only when it
 * runs (at boot and hourly). A table analysed at one row and grown to ten
 * thousand in between is planned as one row: the `podium_events` drain
 * (`kind = ? AND id > ? ORDER BY id`) read the whole table instead of
 * `idx_podium_events_kind`, linear in the table. Across the audited queries,
 * statistics from a one-row table turn 137 of them into whole-table scans
 * (`query-plan-audit.test.ts`). With no statistics for a table the planner
 * assumes a large one and takes its indexes, the plans the audit checks.
 *
 * So after each refresh, every table whose statistics count fewer than
 * {@link PLANNER_STATISTICS_ROW_FLOOR} rows loses them, and the connection
 * reloads what remains. Optimize re-analyses such a table at its next run (an
 * index with no statistics is always stale); below the floor it is dropped
 * again, which costs an ANALYZE of a few hundred rows, and from the floor up
 * its statistics stay. The floor is where statistics stop misleading: from it
 * up, a table described at that size plans every audited query by index.
 */
export const PLANNER_STATISTICS_ROW_FLOOR = 1000

export async function refreshPlannerStatistics(
  session: DriverSession,
  when: 'open' | 'periodic',
): Promise<void> {
  const run = async (sql: string): Promise<void> => {
    await session.execute({ sql, params: [], method: 'run', intent: 'write' })
  }
  await run(`PRAGMA analysis_limit = ${ANALYSIS_LIMIT}`)
  if (when === 'periodic') {
    await run('PRAGMA optimize')
    await forgetTinyTables(session)
    return
  }
  // A database that has never been analysed gets its statistics now, in full
  // (each index sampled up to the limit), rather than whenever optimize judges
  // a table stale; after that, optimize keeps them current.
  const analysed = await session.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
    params: [],
    method: 'all',
    intent: 'read',
  })
  if (analysed.rows.length === 0) await run('ANALYZE')
  await run('PRAGMA optimize = 0x10002')
  await forgetTinyTables(session)
}

/**
 * Drop the statistics of every table analysed below the floor. A row's `stat`
 * starts with the rows its index held; a table's size is its largest (a
 * partial index holds fewer), so a large table keeps the row of a small
 * partial index. The planner reads `sqlite_stat1` when the schema loads;
 * `ANALYZE sqlite_schema` reloads it on this connection.
 */
async function forgetTinyTables(session: DriverSession): Promise<void> {
  const tiny = await session.execute({
    sql: `SELECT tbl FROM sqlite_stat1 GROUP BY tbl HAVING max(CAST(stat AS INTEGER)) < ?`,
    params: [PLANNER_STATISTICS_ROW_FLOOR],
    method: 'all',
    intent: 'read',
  })
  if (tiny.rows.length === 0) return
  await session.execute({
    sql: `DELETE FROM sqlite_stat1 WHERE tbl IN (
      SELECT tbl FROM sqlite_stat1 GROUP BY tbl HAVING max(CAST(stat AS INTEGER)) < ?)`,
    params: [PLANNER_STATISTICS_ROW_FLOOR],
    method: 'run',
    intent: 'write',
  })
  await session.execute({ sql: 'ANALYZE sqlite_schema', params: [], method: 'run', intent: 'write' })
}

export async function setStoreTransferFence(session: DriverSession, held: boolean): Promise<void> {
  await session.execute({
    sql: held ? 'PRAGMA query_only = ON' : 'PRAGMA query_only = OFF',
    params: [],
    method: 'run',
    intent: 'write',
  })
}
