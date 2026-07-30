/**
 * THE PHYSICAL LAYOUT of the web replica store (ADR 6 D5.1 — web IndexedDB, and
 * explicitly NOT drizzle-managed).
 *
 * ADR 6's normative platform note asks for "explicit object stores (or equivalent)
 * for at least: entities (by kind or unified), meta/cursor, outbox, overlay", with
 * grouping left to the implementation provided D4.1 holds. This is the unified
 * shape:
 *
 *   `entities`  keyPath [principal, entity, entityId]  one row per cached entity
 *   `meta`      keyPath [principal, key]               the cursor, and nothing else yet
 *   `outbox`    keyPath [principal, mutationId]        the user's unsent writes
 *
 * THREE OBJECT STORES IN ONE DATABASE, and that is the D4.1 requirement rather
 * than a preference: an IndexedDB transaction may span object stores but never
 * databases, so entities + cursor + outbox in three DATABASES could not commit
 * together at all. The overlay has no store because the kernel keeps it derived
 * from the outbox (`replica/overlay.ts`) — when POD-372 gives it durable state it
 * becomes a fourth store in this same database and inherits the same transaction.
 *
 * PRINCIPAL IS PART OF EVERY KEY, not a filter applied after reading. ADR 6 D4.1
 * and Amendment 1 D15.3 support two principal-bound views over one physical store,
 * and a shared keyspace with a `principal` column would make "the other principal's
 * rows" reachable by any query that forgot to filter. A compound key makes each
 * view's range disjoint by construction.
 *
 * SCHEMA VERSION IS THE IndexedDB DATABASE VERSION (D5.1: "IndexedDB database +
 * object-store version via `IDBOpenDBRequest` `onupgradeneeded`"). Forward-only,
 * adapter-local, and joined to no drizzle journal. A store opened at a HIGHER
 * version than this build knows is refused by IndexedDB itself with a
 * `VersionError`, which the open path treats as D4.5 poison: clear and cold-start,
 * never wedge boot.
 */

import type { IdbDatabaseLike } from './idb'

export const REPLICA_DB_NAME = 'podium-replica'

/**
 * Bump this, and add an arm to `upgradeSchema`, when the physical layout changes.
 * There is no down migration: D5.1 is forward-only, and a client that has to go
 * backwards cold-starts (D4.5) rather than reading a layout it cannot understand.
 */
export const REPLICA_SCHEMA_VERSION = 1

export const ENTITY_STORE = 'entities'
export const META_STORE = 'meta'
export const OUTBOX_STORE = 'outbox'

/** Every store one transaction must be able to span. Order is irrelevant; completeness is not. */
export const ALL_STORES: readonly string[] = [ENTITY_STORE, META_STORE, OUTBOX_STORE]

/** The one `meta` key in use. Namespaced per principal by the compound key. */
export const CURSOR_KEY = 'cursor'

/** A cached entity row, as it is stored. `value` rides through structured clone. */
export interface StoredEntity {
  readonly principal: string
  readonly entity: string
  readonly entityId: string
  readonly value: unknown
  readonly revision?: number
  readonly provenance?: unknown
}

/** A `meta` row. `value` is the cursor for {@link CURSOR_KEY}. */
export interface StoredMeta {
  readonly principal: string
  readonly key: string
  readonly value: unknown
}

/**
 * An outbox row.
 *
 * `ordinal` is the FIFO contract `OutboxStorePort.apply` states in prose —
 * "a first `put` appends, a replacing `put` keeps the record's existing position …
 * an autoincrement column, or IndexedDB key order". IndexedDB key order here is
 * `mutationId` order, which is NOT insertion order, so the position is carried
 * explicitly and rehydration sorts by it. Without this a re-opened store would
 * hand the Outbox its queue in id order, and ADR 3 D12's FIFO-within-a-partition
 * would hold in memory and break on every reload.
 */
export interface StoredOutboxRecord {
  readonly principal: string
  readonly mutationId: string
  readonly ordinal: number
  readonly record: unknown
}

/**
 * Create every object store this version needs.
 *
 * Called from `onupgradeneeded` only, where the version-change transaction is
 * live. Written to be idempotent per store so a future version's arm can add a
 * store without re-creating the others.
 */
export function upgradeSchema(db: IdbDatabaseLike): void {
  if (!db.objectStoreNames.contains(ENTITY_STORE)) {
    db.createObjectStore(ENTITY_STORE, { keyPath: ['principal', 'entity', 'entityId'] })
  }
  if (!db.objectStoreNames.contains(META_STORE)) {
    db.createObjectStore(META_STORE, { keyPath: ['principal', 'key'] })
  }
  if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
    db.createObjectStore(OUTBOX_STORE, { keyPath: ['principal', 'mutationId'] })
  }
}
