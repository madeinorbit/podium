/**
 * THE STORE-LIFECYCLE PORT [POD-6994, POD-6958 design 2.8, 2.9].
 *
 * Everything a store does to its database besides running repository statements:
 * opening the connection and the executor over it, bringing the schema to this build's
 * head, the one-time boot imports, switching the change capture on, the planner's
 * statistics, the traffic temp store, the transfer checkpoint and fence, the schema
 * identity a transfer verifies, the pre-migration backup's free-space check and the
 * recovery snapshots. `store.ts` calls the port's methods and never asks which engine
 * it runs on; {@link openStoreLifecycle} chooses the implementation once, from the
 * store's location (`storeEngineFor`).
 *
 * - SQLite ({@link openSqliteStoreLifecycle}, this file): the self-hosted and desktop
 *   store, exactly as it was before the port. Its steps are the functions below.
 * - Postgres (`./pg/store-lifecycle.ts`, loaded only for a Postgres location): the ledger
 *   check (migrating is a deploy step, design 2.7) and the capture switch; every other
 *   step is the platform's (backups, point-in-time recovery, autovacuum and
 *   autoanalyze) and does nothing there.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { WorkspaceId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { MACHINE_UPDATE_GRANT_ENV, readMachineUpdateJournal } from '@podium/runtime/machine-update'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { importUpdateSigningKey } from '@podium/runtime/update-signing-key'
import { importEnrollmentLedger } from '../enrollment-ledger-import'
import { importFingerprintKey } from '../fingerprint-key-import'
import { importInstallationIdentity } from '../installation-identity-import'
import { importConfigSettings } from '../settings-config-import'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import type { DriverSession, QueryClient } from '../store/executor/driver'
import type { RootStoreExecutor, StoreExecutorOptions } from '../store/executor/executor'
import { openStoreDatabase, storeEngineFor } from '../store-database'
import { dropChangeCapture, installChangeCapture } from '../sync/capture-triggers'
import { type BackupPreflight, backupSpaceShortfall, measureBackupSpace } from './backup'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { latestAppliedMigration, runDrizzleMigrations } from './index'
import { SnapshotVerifier, type SnapshotVerifierDeps } from './snapshot-verifier'

/** The executor's report sinks, which the store defines once for every engine. */
export type StoreLifecycleSinks = Pick<
  StoreExecutorOptions<QueryClient>,
  'watchdog' | 'effectSink' | 'onRefusal'
>

/** What a store's lifecycle is opened with. */
export interface StoreLifecycleOptions {
  /** A store that must not be written (a recovery-only boot): no capture switch-off. */
  readonly queryOnly: boolean
  /** The workspace the boot imports write into (the self-hosted install's). */
  readonly bootWorkspace: WorkspaceId
  readonly sinks: StoreLifecycleSinks
  /** The recovery-snapshot verifier's seams (SQLite). */
  readonly snapshotVerifier: SnapshotVerifierDeps
  /**
   * Postgres only: apply pending migrations at boot instead of refusing a database
   * that is behind (tests and local development; on hosted, migrating is a deploy
   * step, design 2.7). SQLite always migrates at boot.
   */
  readonly migrateAtBoot?: boolean
  /** A boot stage's timing, reported as `store.ts` reports its own. */
  readonly stage: (name: string, startedAt: number) => void
}

/**
 * One store's lifecycle, opened. The executor is the one every repository binds to;
 * the methods run on its exclusive lane where they touch the database.
 */
export interface StoreLifecycle {
  readonly executor: RootStoreExecutor<QueryClient>
  /**
   * The object the store's statement probe hub is keyed by (`statementProbeHubFor`):
   * the SQLite handle, or on Postgres an object of the driver's. Tests count a store's
   * statements through it; on Postgres it is not a database handle and refuses use.
   */
  readonly connection: SqlDatabase
  /** The migrations this open applied, in order. */
  readonly applied: readonly string[]
  /** Whether the store keeps planner statistics of its own (a SQLite file does). */
  readonly keepsPlannerStatistics: boolean
  /**
   * Whether the database can hold the pre-identity credential and invitation tables the
   * boot imports once (`identity/ensure-local-identity.ts`). A SQLite install may (the
   * retirement migration drops them after the import); a Postgres baseline never had them.
   */
  readonly legacyIdentityStorage: boolean
  /**
   * DERIVED CHANGE CAPTURE ON (POD-6920): from here a transaction that does not drain
   * what it captured cannot commit. Until then a write captures nothing that reaches a
   * commit: SQLite has no capture triggers, and Postgres drops a transaction's capture
   * rows before its COMMIT.
   */
  attachChangeCapture(): Promise<void>
  refreshPlannerStatistics(when: 'open' | 'periodic'): Promise<void>
  /** The connection settings for serving traffic, once nothing in the boot builds an index. */
  serveTraffic(): Promise<void>
  /** The newest applied migration's name, which a transfer target verifies. */
  schemaVersionForTransfer(): Promise<string>
  /** Make the database file complete on its own before a transfer snapshot. */
  checkpointForTransfer(): Promise<void>
  /** Hold or release the transfer write fence, on the caller's exclusive-lane session. */
  setTransferFence(session: DriverSession, held: boolean): Promise<void>
  /** Apply the identity storage retirement once the local import committed its receipt. */
  retireImportedIdentityStorage(): Promise<void>
  /** Can this disk hold the pre-migration backup the successor takes at boot? */
  preflightUpdateBackup(): BackupPreflight
  /** The newest verified recovery snapshot's path, from metadata only. */
  latestDatabaseSnapshot(): string | undefined
  /** Reconcile the snapshot catalogue and queue at most one verifier; whether one started. */
  discoverDatabaseSnapshots(): boolean
  /** Stop the snapshot verifier; resolves when its child has exited. */
  closeSnapshots(): Promise<void>
}

/**
 * Open the lifecycle of the store at `location`: a SQLite file path (`:memory:`
 * included) or a `postgres://` URL. The one place the store's engine decides which
 * implementation runs; the Postgres one (and postgres.js with it) loads only here.
 */
export async function openStoreLifecycle(
  location: string,
  options: StoreLifecycleOptions,
): Promise<StoreLifecycle> {
  if (storeEngineFor(location) === 'pg') {
    const { openPgStoreLifecycle } = await import('./pg/store-lifecycle')
    return await openPgStoreLifecycle(location, options)
  }
  return await openSqliteStoreLifecycle(location, options)
}

/**
 * The SQLite store's lifecycle: the boot `store.ts` ran before the port, step for step.
 * The capture triggers come off, the chain migrates on the boot connection with its
 * backup, the boot imports run, and a file store then reopens on a fresh connection
 * with foreign keys enforced (an in-memory store keeps its migrated handle: reopening
 * would lose it).
 */
export async function openSqliteStoreLifecycle(
  path: string,
  options: StoreLifecycleOptions,
): Promise<StoreLifecycle> {
  const { sinks, stage } = options
  const memory = path === ':memory:'
  if (!memory) mkdirSync(dirname(path), { recursive: true })
  const openStarted = performance.now()
  let database = await openStoreDatabase(path)
  stage('store open', openStarted)
  let executor = createBunStoreExecutor({ database, startOpen: true, ...sinks })
  let applied: string[]
  try {
    applied = await executor.exclusive(async (session) => {
      // The change capture triggers come off before anything migrates or
      // repairs: those writes bump `sync_kind` rather than reach the log, and
      // a trigger left by the last boot would refuse them (POD-6920).
      if (!options.queryOnly) await dropChangeCapture(session)
      const migrationStarted = performance.now()
      const result = migrateStoreConnection(database, path)
      stage('migrations', migrationStarted)
      const importsStarted = performance.now()
      const directory = memory ? undefined : dirname(path)
      // The settings blob and the fingerprint key are the boot workspace's
      // (POD-7013); the import receipts stay the install's.
      importConfigSettings(database, options.bootWorkspace, directory)
      importFingerprintKey(database, options.bootWorkspace, directory)
      importInstallationIdentity(database, directory)
      if (directory !== undefined) {
        importEnrollmentLedger(database, directory, options.bootWorkspace)
        importUpdateSigningKey(database, directory)
      }
      stage('imports', importsStarted)
      return result
    })
    if (!memory) {
      // Migration owns its connection, including the OFF/ON bracket. Runtime
      // begins on a fresh connection with enforcement enabled.
      await executor.close()
      database = openDatabase(path)
      executor = createBunStoreExecutor({ database, startOpen: true, ...sinks })
      const runtime = database
      await executor.exclusive(async () => configureStoreConnection(runtime))
    }
  } catch (error) {
    await executor.close()
    throw error
  }
  const db = database
  const store = executor
  const snapshotVerifier = new SnapshotVerifier(path, options.snapshotVerifier)
  return {
    executor: store,
    connection: db,
    applied,
    keepsPlannerStatistics: !memory,
    legacyIdentityStorage: true,
    async attachChangeCapture() {
      await store.exclusive(async (session) => await installChangeCapture(session))
    },
    async refreshPlannerStatistics(when) {
      await store.exclusive(
        async (session) =>
          await withFileTempStore(session, () => refreshPlannerStatistics(session, when)),
      )
    },
    async serveTraffic() {
      await store.exclusive(async (session) => await serveTrafficTempStore(session))
    },
    async schemaVersionForTransfer() {
      return await store.exclusive(async () => {
        const name = latestAppliedMigration(db)
        if (name === undefined) throw new Error('database migration identity is unavailable')
        return name
      })
    },
    async checkpointForTransfer() {
      await store.exclusive(async (session) => await checkpointStore(session))
    },
    async setTransferFence(session, held) {
      await setStoreTransferFence(session, held)
    },
    async retireImportedIdentityStorage() {
      await store.exclusive(async () => retireImportedIdentityStorage(db))
    },
    preflightUpdateBackup() {
      if (memory) return { ok: true }
      const shortfall = backupSpaceShortfall(measureBackupSpace(path))
      return shortfall === undefined ? { ok: true } : { ok: false, detail: shortfall }
    },
    latestDatabaseSnapshot() {
      return memory ? undefined : snapshotVerifier.verifiedFallbackPath()
    },
    discoverDatabaseSnapshots() {
      return memory ? false : snapshotVerifier.discoverAndQueue()
    },
    async closeSnapshots() {
      await snapshotVerifier.close()
    },
  }
}

/** Connection setup and migration bracket, owned by the exclusive boot lane. */
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

/** The initial migration pass already captured the pre-import backup. */
export function retireImportedIdentityStorage(db: SqlDatabase): string[] {
  return withMigrationForeignKeysDisabled(db, () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS))
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
  await session.execute({
    sql: 'ANALYZE sqlite_schema',
    params: [],
    method: 'run',
    intent: 'write',
  })
}

/**
 * SAVEPOINT JOURNALS STAY IN MEMORY WHILE THE STORE SERVES TRAFFIC [POD-6232].
 *
 * A page first written inside a savepoint is copied to the sub-journal, which
 * SQLite keeps in memory up to 64 KiB and then spills to a temp file: a create,
 * an unlink, the 64 KiB and a close, inside whichever statement crosses the
 * line. A session rename nests two savepoints (its commit inside the rename's
 * own transaction, the change append inside the commit), and the five sessions
 * indexes of POD-6160 put that write past the line: the change-log insert went
 * from 57 to 247 µs on that path. The server creates no temp tables, so this
 * moves the sub-journals and the planner's temp b-trees.
 *
 * NOT FOR MIGRATIONS OR MAINTENANCE. An index build sorts in temp, and the one
 * over the 2 GB `applied_mutations` table must be able to spill to disk. So the
 * store switches only once it is open for traffic (after the migrations, the
 * boot repairs, the full-text setup and the opening statistics), and
 * maintenance on a running store runs inside {@link withFileTempStore}.
 * Both run on the exclusive lane: SQLite refuses the change inside a
 * transaction.
 */
export async function serveTrafficTempStore(session: DriverSession): Promise<void> {
  await session.execute({
    sql: 'PRAGMA temp_store = MEMORY',
    params: [],
    method: 'run',
    intent: 'write',
  })
}

/** Run maintenance with temp files on disk, then put back what the connection had. */
export async function withFileTempStore<T>(
  session: DriverSession,
  step: () => Promise<T>,
): Promise<T> {
  const current = await session.execute({
    sql: 'PRAGMA temp_store',
    params: [],
    method: 'get',
    intent: 'read',
  })
  const before = (current.rows[0] as { temp_store: number } | undefined)?.temp_store ?? 0
  await session.execute({
    sql: 'PRAGMA temp_store = FILE',
    params: [],
    method: 'run',
    intent: 'write',
  })
  try {
    return await step()
  } finally {
    await session.execute({
      sql: `PRAGMA temp_store = ${before}`,
      params: [],
      method: 'run',
      intent: 'write',
    })
  }
}

export async function setStoreTransferFence(session: DriverSession, held: boolean): Promise<void> {
  await session.execute({
    sql: held ? 'PRAGMA query_only = ON' : 'PRAGMA query_only = OFF',
    params: [],
    method: 'run',
    intent: 'write',
  })
}
