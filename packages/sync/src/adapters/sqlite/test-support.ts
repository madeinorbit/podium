import { AsyncLocalStorage } from 'node:async_hooks'
import type { MutationId, SessionId, WorkspaceId } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { drizzle as proxyDrizzle } from 'drizzle-orm/sqlite-proxy'
import { sqliteSyncTables } from './binding'
import {
  bindTables,
  CrossWorkspaceStatementError,
  type HandleContext,
  queryHandle,
} from './prepared'
import { workspaceColumn } from './schema'
import type { SyncServerTables } from './server-tables'
import type { StoreDrizzle, StoreQueries, SyncQueries } from './store-queries'
import { SyncRepository } from './sync-repository'
import { SUITE_WORKSPACE_ID, type SyncRepositoryFixture } from './sync-repository.suites'

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
    id: text().notNull(),
    sessionId: text('session_id').$type<SessionId>().notNull(),
    text: text().notNull(),
    queuedAt: integer('queued_at').notNull(),
    inputOrigin: text('input_origin').default('unknown').notNull(),
    attempts: integer().default(0).notNull(),
    deliveryOwner: text('delivery_owner'),
    principalKind: text('principal_kind').default('system').notNull(),
    principalRef: text('principal_ref').default('legacy-session-inbox').notNull(),
    delegationRef: text('delegation_ref'),
    actorKind: text('actor_kind').default('system').notNull(),
    actorId: text('actor_id').default('legacy-session-inbox').notNull(),
    onBehalfOf: text('on_behalf_of'),
    sourceMessageId: text('source_message_id'),
    delivery: text().default('when-ready').notNull(),
    attachmentsJson: text('attachments_json'),
    retractRequestedAt: integer('retract_requested_at'),
    ...workspaceColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id], name: 'queued_messages_pk' }),
    index('queued_messages_session').on(table.workspaceId, table.sessionId, table.queuedAt),
    check('queued_messages_principal_kind', sql`principal_kind IN ('user','agent','system')`),
    check('queued_messages_actor_kind', sql`actor_kind IN ('user','agent','system')`),
  ],
)

export const testUpstreamOutbox = sqliteTable(
  'upstream_outbox',
  {
    mutationId: text('mutation_id').$type<MutationId>().notNull(),
    proc: text().notNull(),
    input: text().notNull(),
    queuedAt: integer('queued_at').notNull(),
    attempts: integer().default(0).notNull(),
    ...workspaceColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.mutationId], name: 'upstream_outbox_pk' }),
  ],
)

/** What the fixture hands `SyncRepository` where the server hands it the real ones.
 *  The fixture is SQLite, where a write needs no capture form. */
export const testSyncServerTables: SyncServerTables = {
  queuedMessages: testQueuedMessages,
  upstreamOutbox: testUpstreamOutbox,
  captureWrite: (write) => write,
}

/**
 * A `SyncRepository` over a fresh in-memory SQLite DB carrying the tables it
 * reads: `changes`, `applied_mutations`, `sync_feed` and `sync_kind` (owned
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
/**
 * The workspace a fixture repository is bound to. A `SyncRepository` names its
 * workspace (POD-7010); the fixtures use the id a self-hosted install has.
 */
export const TEST_WORKSPACE_ID = 'local'

export function createTestSyncRepository(): SyncRepository {
  return new SyncRepository(createTestSyncQueries(), testSyncServerTables, TEST_WORKSPACE_ID)
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
type FullTestDrizzle = ReturnType<typeof proxyDrizzle>
type TestTransactionDrizzle = Parameters<Parameters<FullTestDrizzle['transaction']>[0]>[0]

/** The open test transaction and the workspace it was opened for. */
interface TestFrame {
  readonly tx: FullTestDrizzle | TestTransactionDrizzle
  readonly context: HandleContext
}

const testTransactionScope = new AsyncLocalStorage<TestFrame>()

/** The fixture's instance, bound to the sync tables as a store's is (POD-6977). */
function buildTestDrizzle(db: SqlDatabase): FullTestDrizzle {
  return bindTables(
    proxyDrizzle(async (statement, params, method) => {
      const prepared = db.prepare(statement)
      if (method === 'run') {
        return { rows: [], ...prepared.run(...params) }
      }
      const rows = prepared.values(...params)
      return { rows: (method === 'get' ? rows[0] : rows) as unknown[] }
    }),
    sqliteSyncTables,
  )
}

/** A test store's queries: one workspace's handle and runner, and the bare drizzle instance. */
export type TestSyncQueries = StoreQueries & SyncQueries

/**
 * One workspace's queries over a fixture connection (`workspaceId`, the test
 * workspace when omitted). For a second workspace over the same connection use
 * {@link testWorkspaceQueries}, which shares the drizzle instance and so the
 * transaction scope.
 */
export function createTestSyncQueries(
  db: SqlDatabase = createTestSyncDatabase(),
  workspaceId: string = TEST_WORKSPACE_ID,
): TestSyncQueries {
  return testQueriesOn(buildTestDrizzle(db), workspaceId)
}

/** Another workspace's queries over the same fixture connection and drizzle instance. */
export function testWorkspaceQueries(base: TestSyncQueries, workspaceId: string): TestSyncQueries {
  return testQueriesOn(base.rootDb as unknown as FullTestDrizzle, workspaceId)
}

function testQueriesOn(rootDb: FullTestDrizzle, workspaceId: string): TestSyncQueries {
  const context = Object.freeze({
    kind: 'workspace' as const,
    workspaceId: workspaceId as WorkspaceId,
  })
  return {
    // ONE INSTANCE, inside transactions and out, as the server's seam hands out
    // since POD-6147: the fixture is one synchronous connection, so a statement
    // issued through the root instance inside `createOrJoinTransaction` runs
    // inside that BEGIN, and a query prepared once stays valid in every
    // transaction. The scope below only decides BEGIN versus SAVEPOINT, and
    // records the workspace the transaction was opened for, which the handle's
    // fill checks each statement against (as the server's executor frame does).
    rootDb: rootDb as unknown as StoreDrizzle,
    db: queryHandle(
      rootDb as unknown as StoreDrizzle,
      context,
      () => testTransactionScope.getStore()?.context,
    ),
    createOrJoinTransaction: async (fn) => {
      const current = testTransactionScope.getStore()
      if (current) {
        return current.tx.transaction((inner) =>
          testTransactionScope.run({ tx: inner, context: current.context }, fn),
        )
      }
      return rootDb.transaction((tx) => testTransactionScope.run({ tx, context }, fn), {
        behavior: 'immediate',
      })
    },
  }
}

export function createTestSyncDatabase(): SqlDatabase {
  const db = openDatabase(':memory:')
  db.exec(
    `CREATE TABLE changes (
       workspace_id  TEXT NOT NULL,
       seq        INTEGER NOT NULL,
       entity     TEXT NOT NULL,
       entity_id  TEXT NOT NULL,
       op         TEXT NOT NULL,
       payload    TEXT,
       event_time INTEGER NOT NULL,
       -- ADR 2 D8's provenance triple. NULLABLE: a change the Authority makes on
       -- its own behalf (boot reconcile, steward sweep) has no causing command.
       origin_id    TEXT,
       causation_id TEXT,
       mutation_id  TEXT,
       PRIMARY KEY (workspace_id, seq)
     )`,
  )
  db.exec('CREATE INDEX changes_entity ON changes(workspace_id, entity, entity_id, seq)')
  db.exec('CREATE INDEX changes_event_time ON changes(workspace_id, event_time, seq)')
  db.exec(`CREATE TABLE sync_feed (
    workspace_id TEXT NOT NULL PRIMARY KEY, feed_id TEXT NOT NULL, epoch TEXT NOT NULL,
    minted_at INTEGER NOT NULL, head_seq INTEGER NOT NULL, floor_seq INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE sync_kind (
    workspace_id TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, kind)
  )`)

  db.exec(
    `CREATE TABLE applied_mutations (
       mutation_id TEXT NOT NULL,
       proc        TEXT NOT NULL,
       result      TEXT NOT NULL,
       applied_at  INTEGER NOT NULL,
       workspace_id TEXT NOT NULL,
       PRIMARY KEY (workspace_id, mutation_id)
     )`,
  )
  db.exec(
    // THE FULL session inbox, matching {@link testQueuedMessages} and therefore
    // apps/server's declaration. The eight provenance and attribution columns are
    // not optional decoration: `enqueueMessage` names all twelve, so a fixture
    // that stopped at `attempts` — as this one did until POD-3249 — could not run
    // the repository's own INSERT at all.
    `CREATE TABLE queued_messages (
       id            TEXT NOT NULL,
       session_id    TEXT NOT NULL,
       text          TEXT NOT NULL,
       queued_at     INTEGER NOT NULL,
       input_origin  TEXT NOT NULL DEFAULT 'unknown',
       attempts      INTEGER NOT NULL DEFAULT 0,
       delivery_owner TEXT,
       principal_kind TEXT NOT NULL DEFAULT 'system',
       principal_ref  TEXT NOT NULL DEFAULT 'legacy-session-inbox',
       delegation_ref TEXT,
       actor_kind    TEXT NOT NULL DEFAULT 'system',
       actor_id      TEXT NOT NULL DEFAULT 'legacy-session-inbox',
       on_behalf_of  TEXT,
       source_message_id TEXT,
       delivery      TEXT NOT NULL DEFAULT 'when-ready',
       attachments_json TEXT,
       retract_requested_at INTEGER,
       workspace_id  TEXT NOT NULL,
       PRIMARY KEY (workspace_id, id),
       CONSTRAINT queued_messages_principal_kind CHECK (principal_kind IN ('user','agent','system')),
       CONSTRAINT queued_messages_actor_kind CHECK (actor_kind IN ('user','agent','system'))
     )`,
  )
  db.exec(
    'CREATE INDEX queued_messages_session ON queued_messages(workspace_id, session_id, queued_at)',
  )
  db.exec(
    `CREATE TABLE upstream_outbox (
       mutation_id TEXT NOT NULL,
       proc        TEXT NOT NULL,
       input       TEXT NOT NULL,
       queued_at   INTEGER NOT NULL,
       attempts    INTEGER NOT NULL DEFAULT 0,
       workspace_id TEXT NOT NULL,
       PRIMARY KEY (workspace_id, mutation_id)
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
export function createTestTransact(db: SqlDatabase): <T>(fn: () => Promise<T>) => Promise<T> {
  return createTestSyncQueries(db).createOrJoinTransaction
}

/**
 * The bare fixture as a {@link SyncRepositoryFixture} (POD-6989): one fresh in-memory
 * database, every workspace's queries over its one drizzle instance, and no
 * provisioning, so a workspace's first append or identity write creates its feed row.
 * The server's store shard runs the same suites on the store's own engines.
 */
export function openBareSyncFixture(): SyncRepositoryFixture {
  const db = createTestSyncDatabase()
  const recorded: string[] = []
  const realPrepare = db.prepare.bind(db)
  ;(db as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
    recorded.push(s.replace(/\s+/g, ' ').trim())
    return realPrepare(s)
  }
  const base = createTestSyncQueries(db)
  const queries = (workspaceId: string = SUITE_WORKSPACE_ID) =>
    testWorkspaceQueries(base, workspaceId)
  return {
    engine: 'sqlite',
    provisioned: false,
    serverTables: testSyncServerTables,
    crossWorkspaceRefusal: CrossWorkspaceStatementError,
    queries,
    repository: async (workspaceId = SUITE_WORKSPACE_ID) =>
      new SyncRepository(queries(workspaceId), testSyncServerTables, workspaceId),
    stored: async (text) => realPrepare(text).all() as Record<string, unknown>[],
    seed: async (text) => db.exec(text),
    runInTransaction: async (text) => db.exec(text),
    async record(fn) {
      const from = recorded.length
      await fn()
      return recorded.slice(from)
    },
    close: async () => db.close(),
  }
}
