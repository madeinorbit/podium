import { openDatabase, type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { SyncRepository } from './sync-repository'

/**
 * A `SyncRepository` over a fresh in-memory SQLite DB carrying the four tables it
 * reads: `changes` and `applied_mutations` (owned by THIS adapter's
 * `./schema.ts` since POD-305) plus `queued_messages` and `upstream_outbox`
 * (feature-owned, declared in apps/server's schema — this adapter reads them,
 * and reading a table is not owning it).
 *
 * Test-only fixture. It mirrors the real DDL so this package's unit tests can
 * exercise the real repository SQL without depending on apps/server's migrator.
 *
 * "KEEP IN SYNC" USED TO BE A COMMENT AND IS NOW A TEST. `schema.test.ts`
 * compares these columns against the drizzle schema's declared ones, because a
 * convention between two files is a drift waiting to happen: the fixture would
 * keep passing against a shape nothing deployed. It caught its first drift
 * immediately — POD-305 added the three provenance columns to the real table and
 * this fixture did not have them.
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
       event_time INTEGER NOT NULL,
       -- ADR 2 D8's provenance triple. NULLABLE: a change the Authority makes on
       -- its own behalf (boot reconcile, steward sweep) has no causing command.
       origin_id    TEXT,
       causation_id TEXT,
       mutation_id  TEXT
     )`,
  )
  db.exec('CREATE INDEX changes_entity ON changes(entity, entity_id, seq)')
  db.exec('CREATE INDEX changes_event_time ON changes(event_time)')
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

/**
 * The REAL transact span over `db` — the nesting-safe runtime helper, which is
 * the exact wiring composition uses.
 *
 * Exported from the ADAPTER rather than imported by each kernel test, because
 * `check-boundaries` rule 11 forbids the kernel from importing infrastructure at
 * all, tests included. That is the stricter reading on purpose: a test is where a
 * SQLite import would first look harmless, and a kernel test that imports a
 * database is one refactor away from a kernel MODULE that does.
 *
 * The kernel's atomicity suites still get a real span — they just take it as a
 * fixture from the layer that owns the technology, which is the same shape the
 * production wiring has.
 */
export function createTestTransact(db: SqlDatabase): <T>(fn: () => T) => T {
  return <T>(fn: () => T): T => transaction(db, fn)
}
