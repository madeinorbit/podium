import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { SyncRepository } from './sync-repository'

/**
 * A `SyncRepository` over a fresh in-memory SQLite DB carrying just the four
 * tables it owns (`changes`, `applied_mutations`, `queued_messages`,
 * `upstream_outbox`). Test-only fixture: the real schema DDL lives in the
 * drizzle schema (apps/server/src/migrations/schema.ts) — schema ownership stays
 * with the app that runs the migrator — and this mirrors it so this package's
 * own unit tests can exercise the real repository/SQL without depending on
 * apps/server. Keep in sync with that schema if the sync tables' shape ever
 * changes.
 */
export function createTestSyncRepository(): SyncRepository {
  return new SyncRepository(createTestSyncDatabase())
}

/** The bare in-memory DB behind {@link createTestSyncRepository}, for tests
 *  that need the handle itself (e.g. the Ledger's transact-atomicity suite,
 *  which wraps entity writes and the change append in one transaction). */
export function createTestSyncDatabase(): SqlDatabase {
  const db = openDatabase(':memory:')
  db.exec(
    `CREATE TABLE changes (
       seq        INTEGER PRIMARY KEY AUTOINCREMENT,
       entity     TEXT NOT NULL,
       entity_id  TEXT NOT NULL,
       op         TEXT NOT NULL,
       payload    TEXT,
       event_time INTEGER NOT NULL
     )`,
  )
  db.exec('CREATE INDEX changes_entity ON changes(entity, entity_id, seq)')
  db.exec(
    `CREATE TABLE applied_mutations (
       mutation_id TEXT PRIMARY KEY,
       proc        TEXT NOT NULL,
       result      TEXT NOT NULL,
       applied_at  INTEGER NOT NULL
     )`,
  )
  db.exec(
    `CREATE TABLE queued_messages (
       id         TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       text       TEXT NOT NULL,
       queued_at  INTEGER NOT NULL,
       attempts   INTEGER NOT NULL DEFAULT 0
     )`,
  )
  db.exec('CREATE INDEX queued_messages_session ON queued_messages(session_id, queued_at)')
  db.exec(
    `CREATE TABLE upstream_outbox (
       mutation_id TEXT PRIMARY KEY,
       proc        TEXT NOT NULL,
       input       TEXT NOT NULL,
       queued_at   INTEGER NOT NULL,
       attempts    INTEGER NOT NULL DEFAULT 0
     )`,
  )
  return db
}
