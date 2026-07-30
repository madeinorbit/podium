/**
 * THE PHYSICAL LAYOUT of the mobile replica store (ADR 6 D5.1 — mobile SQLite, and
 * explicitly NOT drizzle-managed).
 *
 * ADR 6's normative platform note asks for "explicit object stores (or equivalent)
 * for at least: entities (by kind or unified), meta/cursor, outbox, overlay", and
 * D5.1 adds for mobile: "integer (or ordered) `schema_version` inside the SQLite DB;
 * forward-only migrations owned by the mobile adapter module … prefer few tables
 * keyed by entity kind over mirroring the full server relational schema."
 *
 * This is that shape:
 *
 *   `entities`        PK (principal, entity, entity_id)   one row per cached entity
 *   `meta`            PK (principal, key)                 the cursor, and nothing else yet
 *   `outbox`          PK (principal, mutation_id)         the user's unsent writes
 *   `schema_version`  singleton row                       D5.1's adapter-local version
 *
 * FOUR TABLES IN ONE DATABASE FILE, which is the D4.1 requirement rather than a
 * preference: a SQLite transaction spans the tables of one connection, so entities +
 * cursor + outbox in three FILES could not commit together at all. The overlay has
 * no table because the kernel keeps it derived from the outbox
 * (`replica/overlay.ts`); when POD-372 gives it durable state it becomes a fifth
 * table in this same file and inherits the same transaction.
 *
 * PRINCIPAL IS PART OF EVERY PRIMARY KEY, not a filter applied after reading. ADR 6
 * D4.1 and Amendment 1 D15.3 support two principal-bound views over one physical
 * store, and a shared keyspace would make "the other principal's rows" reachable by
 * any query that forgot a `WHERE`. A compound key makes each view's range disjoint
 * by construction — and every statement in `store.ts` binds the principal.
 *
 * SCHEMA VERSION IS A ROW, NOT `PRAGMA user_version`, and that is a decision worth
 * stating. `user_version` is a 32-bit field in the file header that any tool can set
 * and that carries no room for the provenance a later migration will want; a table
 * is what D5.1 asks for ("integer (or ordered) `schema_version` INSIDE the SQLite
 * DB") and it participates in the same transaction as everything else. It is joined
 * to no drizzle journal: `apps/server` remains the sole drizzle-kit consumer (D5.3),
 * and `migration:check` does not see this file.
 *
 * VALUES ARE JSON TEXT. Anything that survives only by object identity fails here
 * the same way it would on device — the class of bug ADR 6 D4 exists to catch — and
 * the round trip is asserted rather than assumed (`store.test.ts`).
 */

import type { SqlDatabaseLike } from './sql'

/** The database file name a mobile client opens. Composition chooses the directory. */
export const REPLICA_DB_NAME = 'podium-replica.db'

/**
 * Bump this when the physical layout changes.
 *
 * FORWARD-ONLY, with no down migration (D5.1). A store written by a NEWER build than
 * this one cannot be read, and a store written by an OLDER one has no upgrade arm at
 * version 1 because there is no earlier version in existence — both are handled by
 * ADR 6 D6's upgrade-or-rebootstrap posture: clear the file and cold start from the
 * Authority (`SqliteSyncStore.open`). When a version 2 lands, the older-version arm
 * in `open()` is where its migration goes, and the D6 posture stays as the fallback
 * for anything the migration cannot carry.
 */
export const REPLICA_SCHEMA_VERSION = 1

export const ENTITY_TABLE = 'entities'
export const META_TABLE = 'meta'
export const OUTBOX_TABLE = 'outbox'
export const SCHEMA_VERSION_TABLE = 'schema_version'

/** Every table one transaction must be able to span. Order is irrelevant; completeness is not. */
export const ALL_TABLES: readonly string[] = [
  ENTITY_TABLE,
  META_TABLE,
  OUTBOX_TABLE,
  SCHEMA_VERSION_TABLE,
]

/** The one `meta` key in use. Namespaced per principal by the compound key. */
export const CURSOR_KEY = 'cursor'

/** A cached entity row, as it is stored. */
export interface StoredEntity {
  readonly principal: string
  readonly entity: string
  readonly entityId: string
  readonly value: unknown
  readonly revision?: number
  readonly provenance?: unknown
}

/**
 * An outbox row.
 *
 * `ordinal` is the FIFO contract `OutboxStorePort.apply` states in prose — "a first
 * `put` appends, a replacing `put` keeps the record's existing position … an
 * autoincrement column, or IndexedDB key order". SQLite returns rows in whatever
 * order the query asks for and in PRIMARY KEY order when it asks for none, which
 * here is `mutation_id` order and NOT insertion order. So the position is carried
 * explicitly and every read sorts by it. Without this a re-opened store would hand
 * the Outbox its queue in id order, and ADR 3 D12's FIFO-within-a-partition would
 * hold in memory and break on every cold start — which on mobile is every time the
 * OS reclaims the process.
 */
export interface StoredOutboxRecord {
  readonly principal: string
  readonly mutationId: string
  readonly ordinal: number
  readonly record: unknown
}

/**
 * Create every table this version needs, and stamp the version.
 *
 * `IF NOT EXISTS` throughout so a future version's migration arm can add a table
 * without re-creating the others. Called inside the open handshake's own
 * transaction, so a store that dies halfway through creation has no half-schema to
 * come back to.
 */
export function applySchema(db: SqlDatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ENTITY_TABLE} (
      principal TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      value TEXT NOT NULL,
      revision INTEGER,
      provenance TEXT,
      PRIMARY KEY (principal, entity, entity_id)
    );
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      principal TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (principal, key)
    );
    CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
      principal TEXT NOT NULL,
      mutation_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      record TEXT NOT NULL,
      PRIMARY KEY (principal, mutation_id)
    );
    CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSION_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `)
  db.prepare(
    `INSERT INTO ${SCHEMA_VERSION_TABLE} (singleton, version) VALUES (1, ?)
     ON CONFLICT(singleton) DO UPDATE SET version = excluded.version`,
  ).run(REPLICA_SCHEMA_VERSION)
}

/**
 * The version stamped in the file, or `null` when this is not a replica database.
 *
 * `null` covers both "brand new file" and "a file whose tables we have not created
 * yet", which the open path treats identically — there is nothing to lose in either.
 * A file that is not a SQLite database at all throws instead, and the open path
 * treats that as D4.5 poison.
 */
export function readSchemaVersion(db: SqlDatabaseLike): number | null {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(SCHEMA_VERSION_TABLE) as { name?: string } | undefined
  if (table?.name === undefined) return null
  const row = db.prepare(`SELECT version FROM ${SCHEMA_VERSION_TABLE} WHERE singleton = 1`).get() as
    | { version?: unknown }
    | undefined
  const version = row?.version
  return typeof version === 'number' ? version : null
}

/** Drop every table this adapter owns. The D4.5 / D6 clear, before a cold start. */
export function dropSchema(db: SqlDatabaseLike): void {
  for (const table of ALL_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
}
