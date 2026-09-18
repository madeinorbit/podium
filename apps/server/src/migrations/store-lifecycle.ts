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

export async function setStoreTransferFence(session: DriverSession, held: boolean): Promise<void> {
  await session.execute({
    sql: held ? 'PRAGMA query_only = ON' : 'PRAGMA query_only = OFF',
    params: [],
    method: 'run',
    intent: 'write',
  })
}
