/**
 * THE SYNC TABLES ON POSTGRES, AND THE TWINS' COLUMN TYPES [POD-6978, POD-6958 design 2.2, 2.3].
 *
 * The twin of `../sqlite/schema.ts`, under the same export names, and
 * {@link pgSyncTables}, the twin of `sqliteSyncTables`: what a Postgres store binds as
 * the sync adapter's tables.
 *
 * GENERATED ONCE by `scripts/generate-pg-schema.ts`, then kept as source (the tables
 * below the column types); the server's `migrations/pg/schema-parity.test.ts` holds the
 * two schemas to the same structure, and its type test to the same row types.
 *
 * THE COLUMN TYPES (design 2.3) are declared here because both twins use them and this
 * package cannot import the server:
 *
 * | column class (SQLite)                 | Postgres                      | Drizzle here       |
 * |--------------------------------------|-------------------------------|--------------------|
 * | ISO timestamp text (class timestamp) | `timestamptz(3)`              | `isoTimestamp`     |
 * | JSON text (class json)               | `json`                        | `jsonText`         |
 * | JSON, `mode: 'json'`                 | `json`                        | `jsonValue`        |
 * | other text (class text)              | `text COLLATE "C"`            | `textC`            |
 * | integer                              | `bigint`                      | `int8`             |
 * | integer one-column primary key       | `bigint` identity, by default | `int8` + identity  |
 * | integer, `mode: 'boolean'`           | `boolean`                     | `boolean`          |
 * | real                                 | `double precision`            | `doublePrecision`  |
 *
 * Neither JSON type is drizzle's `json()`/`jsonb()`, which would encode a string value a
 * second time; the Postgres driver reads `json` as its raw text, so `jsonText` passes it
 * through and `jsonValue` parses it, as SQLite's `mode: 'json'` does.
 */

import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  timestamp,
} from 'drizzle-orm/pg-core'
import type * as sqlite from '../sqlite/schema'

/** Text in byte order (`COLLATE "C"`), as SQLite compares text. Drizzle's `text()` has no collation. */
export const textC = customType<{ data: string; driverData: string }>({
  dataType: () => 'text COLLATE "C"',
})

/** JSON kept as its exact text, both ways. */
export const jsonText = customType<{ data: string; driverData: string }>({
  dataType: () => 'json',
})

/** JSON parsed on read and stringified on write: SQLite's `text({ mode: 'json' })`. */
export const jsonValue = customType<{ data: unknown; driverData: string }>({
  dataType: () => 'json',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as unknown,
})

/** An ISO timestamp: `timestamptz(3)`, read and written as `toISOString()` text. */
export const isoTimestamp = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3, mode: 'string' })

/** An integer: `bigint`, read as a number (the driver refuses values beyond 2^53). */
export const int8 = (name: string) => bigint(name, { mode: 'number' })

/** The SQLite row of the twin table, whose column types every twin column takes. */
type SqliteRow<T extends keyof typeof sqlite> = (typeof sqlite)[T] extends {
  readonly $inferSelect: infer Row
}
  ? Row
  : never

export const appliedMutations = pgTable(
  'applied_mutations',
  {
    mutationId: textC('mutation_id')
      .primaryKey()
      .$type<SqliteRow<'appliedMutations'>['mutationId']>(),
    proc: textC('proc').notNull().$type<SqliteRow<'appliedMutations'>['proc']>(),
    result: textC('result').notNull().$type<SqliteRow<'appliedMutations'>['result']>(),
    appliedAt: int8('applied_at').notNull().$type<SqliteRow<'appliedMutations'>['appliedAt']>(),
    workspaceId: textC('workspace_id')
      .notNull()
      .default(sql`'local'`)
      .$type<SqliteRow<'appliedMutations'>['workspaceId']>(),
  },
  (table) => [index('idx_applied_mutations_applied_at').on(table.appliedAt)],
)

export const changes = pgTable(
  'changes',
  {
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'changes'>['workspaceId']>(),
    seq: int8('seq').notNull().$type<SqliteRow<'changes'>['seq']>(),
    entity: textC('entity').notNull().$type<SqliteRow<'changes'>['entity']>(),
    entityId: textC('entity_id').notNull().$type<SqliteRow<'changes'>['entityId']>(),
    op: textC('op').notNull().$type<SqliteRow<'changes'>['op']>(),
    payload: jsonText('payload').$type<SqliteRow<'changes'>['payload']>(),
    eventTime: int8('event_time').notNull().$type<SqliteRow<'changes'>['eventTime']>(),
    originId: textC('origin_id').$type<SqliteRow<'changes'>['originId']>(),
    causationId: textC('causation_id').$type<SqliteRow<'changes'>['causationId']>(),
    mutationId: textC('mutation_id').$type<SqliteRow<'changes'>['mutationId']>(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.seq] }),
    index('changes_entity').on(table.workspaceId, table.entity, table.entityId, table.seq),
    index('changes_event_time').on(table.workspaceId, table.eventTime, table.seq),
  ],
)

export const feedIdentity = pgTable(
  'feed_identity',
  {
    singleton: int8('singleton')
      .primaryKey()
      .generatedByDefaultAsIdentity()
      .$type<SqliteRow<'feedIdentity'>['singleton']>(),
    feedId: textC('feed_id').notNull().$type<SqliteRow<'feedIdentity'>['feedId']>(),
    epoch: textC('epoch').notNull().$type<SqliteRow<'feedIdentity'>['epoch']>(),
    mintedAt: int8('minted_at').notNull().$type<SqliteRow<'feedIdentity'>['mintedAt']>(),
  },
  (_table) => [check('feed_identity_singleton', sql`"singleton" = 1`)],
)

export const syncCapture = pgTable(
  'sync_capture',
  {
    id: int8('id')
      .primaryKey()
      .generatedByDefaultAsIdentity()
      .$type<SqliteRow<'syncCapture'>['id']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'syncCapture'>['kind']>(),
    source: int8('source').notNull().$type<SqliteRow<'syncCapture'>['source']>(),
    op: textC('op').notNull().$type<SqliteRow<'syncCapture'>['op']>(),
    oldKey: textC('old_key').$type<SqliteRow<'syncCapture'>['oldKey']>(),
    newKey: textC('new_key').$type<SqliteRow<'syncCapture'>['newKey']>(),
    undrained: int8('undrained')
      .notNull()
      .default(0)
      .$type<SqliteRow<'syncCapture'>['undrained']>(),
  },
  (table) => [
    foreignKey({
      name: 'fk_sync_capture_undrained_sync_capture_guard_id_fk',
      columns: [table.undrained],
      foreignColumns: [syncCaptureGuard.id],
    }),
  ],
)

export const syncCaptureGuard = pgTable('sync_capture_guard', {
  id: int8('id')
    .primaryKey()
    .generatedByDefaultAsIdentity()
    .$type<SqliteRow<'syncCaptureGuard'>['id']>(),
})

export const syncFeed = pgTable('sync_feed', {
  workspaceId: textC('workspace_id').primaryKey().$type<SqliteRow<'syncFeed'>['workspaceId']>(),
  feedId: textC('feed_id').notNull().$type<SqliteRow<'syncFeed'>['feedId']>(),
  epoch: textC('epoch').notNull().$type<SqliteRow<'syncFeed'>['epoch']>(),
  mintedAt: int8('minted_at').notNull().$type<SqliteRow<'syncFeed'>['mintedAt']>(),
  headSeq: int8('head_seq').notNull().$type<SqliteRow<'syncFeed'>['headSeq']>(),
  floorSeq: int8('floor_seq').notNull().$type<SqliteRow<'syncFeed'>['floorSeq']>(),
})

export const syncKind = pgTable(
  'sync_kind',
  {
    workspaceId: textC('workspace_id').notNull().$type<SqliteRow<'syncKind'>['workspaceId']>(),
    kind: textC('kind').notNull().$type<SqliteRow<'syncKind'>['kind']>(),
    generation: int8('generation').notNull().$type<SqliteRow<'syncKind'>['generation']>(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.kind] })],
)

/** The sync adapter's tables on Postgres: the twin of `sqliteSyncTables`. */
export const pgSyncTables = Object.freeze({
  appliedMutations,
  changes,
  feedIdentity,
  syncCapture,
  syncCaptureGuard,
  syncFeed,
  syncKind,
})
