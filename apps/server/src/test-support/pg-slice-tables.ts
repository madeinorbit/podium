/**
 * THE TWO-ENGINE SLICE'S POSTGRES TABLES, AND A STORE OVER THEM [POD-6995, POD-6958
 * design 2.1, 2.3].
 *
 * `store/read-watermarks.ts` and `store/quota-history.ts` run on both engines from one
 * query source. Until POD-6978 generates `migrations/pg/schema.ts`, their two tables'
 * Postgres twins are written here by hand, in the native types of design 2.3 (operator
 * decision OD5), under the SQLite export names so `bindingFor('pg', …)` hands each
 * definition its `t.recapWatermarks` and `t.quotaWindows`:
 *
 * | column class                  | SQLite              | Postgres                                  |
 * |-------------------------------|---------------------|-------------------------------------------|
 * | ISO timestamp (`updated_at`)  | `text`              | `timestamptz(3)`, Drizzle `mode: 'string'` |
 * | JSON (`trail_json`)           | `text`              | `json`, the `jsonText` custom type        |
 * | epoch ms, buckets, counts     | `integer`           | `bigint`, `mode: 'number'`                 |
 * | boolean (`partial`)           | `integer` 0/1       | `boolean`                                 |
 * | percents                      | `real`              | `double precision`                        |
 * | every other text              | `text`              | `text COLLATE "C"`                        |
 *
 * `store/two-engine-slice.type-test.ts` proves each twin's `$inferSelect` and
 * `$inferInsert` equal its SQLite table's, which is what makes the binding's one cast
 * safe for these two tables. POD-6978 replaces this file with the generated schema.
 *
 * {@link openSliceStore} is the slice's store: the repositories' queries on the test
 * run's engine. On SQLite it is a migrated in-memory database through the store
 * executor, as before; on the `server-store-pg` lane a fresh Postgres clone holding the
 * two tables, through the Postgres driver (strict timestamps on, the leg's default) and
 * the Postgres query layer over these twins.
 */

import type { SessionId, UserId } from '@podium/model'
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import { attachLaneIntentAudit } from '../store/executor/lane-intent-audit'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import type { StoreQueries } from '../store/executor/sync-drizzle'
import { openMigratedTestDatabase } from './migrated-database'
import {
  clonePgTestDatabase,
  connectPgTest,
  type TestStoreEngine,
  testStoreEngine,
} from './pg-test-database'
import { stageASeam } from './stage-a-seam'

/** JSON kept as its text both ways: what the driver reads a `json` value as (POD-6978's `jsonText`). */
export const jsonText = customType<{ data: string; driverData: string }>({
  dataType: () => 'json',
})

/** An ISO timestamp column: `timestamptz(3)`, read and written as `toISOString()` text. */
const isoTimestamp = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3, mode: 'string' })

/** An integer column: `bigint`, read as a number (the driver refuses values beyond 2^53). */
const int8 = (name: string) => bigint(name, { mode: 'number' })

export const recapWatermarks = pgTable(
  'recap_watermarks',
  {
    reader: text().notNull(),
    sessionId: text('session_id').$type<SessionId>().notNull(),
    watermark: text().notNull(),
    updatedAt: isoTimestamp('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reader, table.sessionId], name: 'recap_watermarks_pk' }),
  ],
)

export const quotaWindows = pgTable(
  'quota_windows',
  {
    accountKey: text('account_key').notNull(),
    agent: text().notNull(),
    windowKey: text('window_key').notNull(),
    resetsAtBucket: int8('resets_at_bucket').notNull(),
    label: text().notNull(),
    scopeModel: text('scope_model'),
    plan: text(),
    resetsAtMs: int8('resets_at_ms').notNull(),
    startedAtMs: int8('started_at_ms'),
    windowMinutes: int8('window_minutes').notNull(),
    firstSeenMs: int8('first_seen_ms').notNull(),
    lastSeenMs: int8('last_seen_ms').notNull(),
    firstPercent: doublePrecision('first_percent').notNull(),
    peakPercent: doublePrecision('peak_percent').notNull(),
    lastPercent: doublePrecision('last_percent').notNull(),
    sampleCount: int8('sample_count').notNull(),
    partial: boolean().notNull(),
    source: text().notNull(),
    trailJson: jsonText('trail_json').notNull(),
    ownerUserId: text('owner_user_id').$type<UserId>(),
  },
  (table) => [
    index('idx_quota_windows_series').on(table.accountKey, table.windowKey, table.resetsAtMs),
    index('idx_quota_windows_owner').on(
      table.ownerUserId,
      table.accountKey,
      table.windowKey,
      table.resetsAtMs,
    ),
    index('idx_quota_windows_resets').on(table.resetsAtMs),
    primaryKey({
      columns: [table.accountKey, table.windowKey, table.resetsAtBucket],
      name: 'quota_windows_pk',
    }),
  ],
)

/** The slice's Postgres table set, under the SQLite schema's export names. */
export const PG_SLICE_TABLES = Object.freeze({ recapWatermarks, quotaWindows })

/**
 * The two tables' DDL, written out rather than generated: the twin above says what
 * Drizzle builds against, this says what the database holds, `COLLATE "C"` included,
 * which Drizzle's text column cannot declare.
 */
export const PG_SLICE_DDL: readonly string[] = [
  `CREATE TABLE recap_watermarks (
    reader text COLLATE "C" NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    watermark text COLLATE "C" NOT NULL,
    updated_at timestamptz(3) NOT NULL,
    CONSTRAINT recap_watermarks_pk PRIMARY KEY (reader, session_id)
  )`,
  `CREATE TABLE quota_windows (
    account_key text COLLATE "C" NOT NULL,
    agent text COLLATE "C" NOT NULL,
    window_key text COLLATE "C" NOT NULL,
    resets_at_bucket bigint NOT NULL,
    label text COLLATE "C" NOT NULL,
    scope_model text COLLATE "C",
    plan text COLLATE "C",
    resets_at_ms bigint NOT NULL,
    started_at_ms bigint,
    window_minutes bigint NOT NULL,
    first_seen_ms bigint NOT NULL,
    last_seen_ms bigint NOT NULL,
    first_percent double precision NOT NULL,
    peak_percent double precision NOT NULL,
    last_percent double precision NOT NULL,
    sample_count bigint NOT NULL,
    partial boolean NOT NULL,
    source text COLLATE "C" NOT NULL,
    trail_json json NOT NULL,
    owner_user_id text COLLATE "C",
    CONSTRAINT quota_windows_pk PRIMARY KEY (account_key, window_key, resets_at_bucket)
  )`,
  'CREATE INDEX idx_quota_windows_series ON quota_windows (account_key, window_key, resets_at_ms)',
  'CREATE INDEX idx_quota_windows_owner ON quota_windows (owner_user_id, account_key, window_key, resets_at_ms)',
  'CREATE INDEX idx_quota_windows_resets ON quota_windows (resets_at_ms)',
]

/** The slice's repositories' store on the run's engine. */
export interface SliceStore {
  readonly engine: TestStoreEngine
  /** What the repositories are constructed with, as `store.ts` constructs them. */
  readonly queries: StoreQueries
  /** What `countStatements` attaches to: the store's driver, on either engine. */
  readonly probeTarget: { readonly db: object }
  close(): Promise<void>
}

/** The slice's store on the test run's engine (`PODIUM_TEST_STORE_ENGINE`). */
export async function openSliceStore(): Promise<SliceStore> {
  if (testStoreEngine() !== 'pg') {
    const database = openMigratedTestDatabase()
    return {
      engine: 'sqlite',
      queries: stageASeam(database),
      probeTarget: { db: database },
      close: async () => database.close(),
    }
  }
  const { url } = await clonePgTestDatabase()
  const admin = connectPgTest(url, 1)
  try {
    for (const statement of PG_SLICE_DDL) await admin.unsafe(statement)
  } finally {
    await admin.close({ timeout: 5 })
  }
  // The statement probe's hub, keyed by an object of the store's own, as the bun
  // driver's is keyed by its database; the lane's intent audit grades it too.
  const connection = {}
  const hub = statementProbeHubFor(connection)
  attachLaneIntentAudit(hub)
  const executor: RootStoreExecutor<QueryClient> = createStoreExecutor<QueryClient>({
    driver: instrumentDriver(createPgStoreDriver({ url, poolSize: 2 }), hub),
    queryLayer: pgQueryLayer(PG_SLICE_TABLES),
    startOpen: true,
  })
  return {
    engine: 'pg',
    queries: executor.queries,
    probeTarget: { db: connection },
    close: async () => await executor.close(),
  }
}
