/** Connection setup and migration bracket, owned by the exclusive boot lane. */
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
  // This bracket belongs to this connection, OUTSIDE drizzle's transaction.
  // Inside BEGIN, foreign_keys is a no-op and a rebuild can delete child rows.
  return withMigrationForeignKeysDisabled(db, () =>
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS, {
      dbPath: path === ':memory:' ? undefined : path,
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
