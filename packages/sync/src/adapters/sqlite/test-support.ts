import { openDatabase, type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { SyncServerTables } from './server-tables'
import type { SyncDrizzle, SyncQueries } from './store-queries'
import { SyncRepository } from './sync-repository'

/**
 * THE FIXTURE'S STAND-IN FOR THE TWO SERVER-OWNED TABLES (POD-3249).
 *
 * `SyncRepository` takes `queued_messages` and `upstream_outbox` as injected
 * drizzle objects, because a package may not import `apps/server`'s schema
 * (`./server-tables.ts`). This package's own unit tests need something to hand
 * it, and they need it to be the same shape the product deploys — so the
 * declarations are mirrored here, beside the DDL that has always mirrored them,
 * and `schema.test.ts` holds the two halves together the same way it does for
 * the adapter's own tables.
 *
 * MIRRORED, NOT OWNED. `apps/server/src/migrations/schema.ts` is still the one
 * declaration that migrations are generated from; nothing here reaches
 * `drizzle.config.ts`, so this emits no migration and cannot change the product
 * schema. It is a test fixture with a type, which is what it was before — it
 * just stopped being only a string.
 */
export const testQueuedMessages = sqliteTable(
  'queued_messages',
  {
    id: text().primaryKey(),
    sessionId: text('session_id').notNull(),
    text: text().notNull(),
    queuedAt: integer('queued_at').notNull(),
    inputOrigin: text('input_origin').default('unknown').notNull(),
    attempts: integer().default(0).notNull(),
    principalKind: text('principal_kind').default('system').notNull(),
    principalRef: text('principal_ref').default('legacy-session-inbox').notNull(),
    delegationRef: text('delegation_ref'),
    actorKind: text('actor_kind').default('system').notNull(),
    actorId: text('actor_id').default('legacy-session-inbox').notNull(),
    onBehalfOf: text('on_behalf_of'),
    sourceMessageId: text('source_message_id'),
  },
  (table) => [
    index('queued_messages_session').on(table.sessionId, table.queuedAt),
    check('queued_messages_principal_kind', sql`principal_kind IN ('user','agent','system')`),
    check('queued_messages_actor_kind', sql`actor_kind IN ('user','agent','system')`),
  ],
)

export const testUpstreamOutbox = sqliteTable('upstream_outbox', {
  mutationId: text('mutation_id').primaryKey(),
  proc: text().notNull(),
  input: text().notNull(),
  queuedAt: integer('queued_at').notNull(),
  attempts: integer().default(0).notNull(),
})

/** What the fixture hands `SyncRepository` where the server hands it the real ones. */
export const testSyncServerTables: SyncServerTables = {
  queuedMessages: testQueuedMessages,
  upstreamOutbox: testUpstreamOutbox,
}

/**
 * A `SyncRepository` over a fresh in-memory SQLite DB carrying the tables it
 * reads: `changes`, `change_latest`, `applied_mutations` and `feed_identity` (owned
 * by THIS adapter's `./schema.ts` since POD-305) plus `queued_messages` and `upstream_outbox`
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
  return new SyncRepository(createTestSyncQueries(), testSyncServerTables)
}

/**
 * THE QUERY CAPABILITY over a fresh fixture database (POD-3338 for the port,
 * POD-3416 for what it now carries).
 *
 * `SyncRepository` takes the store's drizzle instance and its transaction,
 * narrowed to what it uses (`./store-queries.ts`), and this package's tests have
 * no store to build one from — so the fixture assembles the same two-member
 * object over a connection from {@link createTestSyncDatabase}.
 *
 * IT MIRRORS `apps/server`'s `syncQueriesOver` rather than importing it, because
 * a package may not import an app — the same reason `./store-queries.ts` declares
 * the port structurally instead of naming the server's binding. The one
 * difference is deliberate and is the instrumentation the server's seam carries:
 * `clientOverWrapper` routes drizzle through the `SqlDatabase` WRAPPER so the
 * query-count probes keep seeing converted statements (POD-3395). A fixture feeds
 * no probe, so it hands drizzle the same three-method shape over the wrapper
 * without the refusal stub.
 */
export function createTestSyncQueries(db: SqlDatabase = createTestSyncDatabase()): SyncQueries {
  const client = {
    exec: (statement: string) => db.exec(statement),
    query: (statement: string) => db.prepare(statement),
    transaction: () => {
      throw new Error(
        'the fixture drizzle instance has no transaction of its own: it keeps its own nesting ' +
          'state and would open a span the store does not know about. Use `transact` ' +
          '(POD-3221 spec rule 7).',
      )
    },
  }
  return {
    db: drizzle({ client: client as never }) as SyncDrizzle,
    transact: createTestTransact(db),
  }
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
    // POD-678's installed world: the latest LIVE state per (entity, id), written
    // by the same append that writes `changes` and never pruned with it.
    `CREATE TABLE change_latest (
       entity    TEXT NOT NULL,
       entity_id TEXT NOT NULL,
       seq       INTEGER NOT NULL,
       payload   TEXT NOT NULL,
       PRIMARY KEY (entity, entity_id)
     )`,
  )
  db.exec('CREATE INDEX change_latest_seq ON change_latest(seq)')
  db.exec(
    `CREATE TABLE applied_mutations (
       mutation_id TEXT PRIMARY KEY,
       proc        TEXT NOT NULL,
       result      TEXT NOT NULL,
       applied_at  INTEGER NOT NULL
     )`,
  )
  db.exec(
    // ADR 2 D1's feed identity. ONE row, pinned by a constant primary key, so
    // "there is exactly one current generation" is a property of the schema
    // rather than a rule every writer has to remember.
    `CREATE TABLE feed_identity (
       singleton INTEGER PRIMARY KEY,
       feed_id   TEXT NOT NULL,
       epoch     TEXT NOT NULL,
       minted_at INTEGER NOT NULL
     )`,
  )
  db.exec(
    // THE FULL session inbox, matching {@link testQueuedMessages} and therefore
    // apps/server's declaration. The eight provenance and attribution columns are
    // not optional decoration: `enqueueMessage` names all twelve, so a fixture
    // that stopped at `attempts` — as this one did until POD-3249 — could not run
    // the repository's own INSERT at all.
    `CREATE TABLE queued_messages (
       id            TEXT PRIMARY KEY,
       session_id    TEXT NOT NULL,
       text          TEXT NOT NULL,
       queued_at     INTEGER NOT NULL,
       input_origin  TEXT NOT NULL DEFAULT 'unknown',
       attempts      INTEGER NOT NULL DEFAULT 0,
       principal_kind TEXT NOT NULL DEFAULT 'system',
       principal_ref  TEXT NOT NULL DEFAULT 'legacy-session-inbox',
       delegation_ref TEXT,
       actor_kind    TEXT NOT NULL DEFAULT 'system',
       actor_id      TEXT NOT NULL DEFAULT 'legacy-session-inbox',
       on_behalf_of  TEXT,
       source_message_id TEXT,
       CONSTRAINT queued_messages_principal_kind CHECK (principal_kind IN ('user','agent','system')),
       CONSTRAINT queued_messages_actor_kind CHECK (actor_kind IN ('user','agent','system'))
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
