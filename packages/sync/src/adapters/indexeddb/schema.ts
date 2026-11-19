/**
 * THE PHYSICAL LAYOUT of the web replica store (ADR 6 D5.1 — web IndexedDB, and
 * explicitly NOT drizzle-managed).
 *
 * ADR 6's normative platform note asks for "explicit object stores (or equivalent)
 * for at least: entities (by kind or unified), meta/cursor, outbox, overlay", with
 * grouping left to the implementation provided D4.1 holds. This is the unified
 * shape:
 *
 *   `entities`    keyPath [principal, entity, entityId]  one row per cached entity
 *   `meta`        keyPath [principal, key]               cursor, markers, policy, load state
 *   `outbox`      keyPath [principal, mutationId]        the user's unsent writes
 *   `disk-index`  keyPath [principal, key]               the disk index (version 2, POD-7159)
 *
 * The disk index is one row per record (its feed number, level, size, holders
 * and, for a record with a stub, its stub) and one per instance (when it was
 * last read, whether it is stale). It is read whole at open, with no entity
 * row, and written in the same transaction as the rows it describes.
 *
 * OBJECT STORES IN ONE DATABASE, and that is the D4.1 requirement rather
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

import { COLLECTIONS, type MutationId } from '@podium/model'
import { decodeCacheMeta } from '../../replica/cache-state'
import type { IdbDatabaseLike, IdbKeyRangeLike, IdbTransactionLike } from './idb'

export const REPLICA_DB_NAME = 'podium-replica'

/**
 * Bump this, and add an arm to `upgradeSchema`, when the physical layout changes.
 * There is no down migration: D5.1 is forward-only, and a client that has to go
 * backwards cold-starts (D4.5) rather than reading a layout it cannot understand.
 */
export const REPLICA_SCHEMA_VERSION = 3

export const ENTITY_STORE = 'entities'
export const META_STORE = 'meta'
export const OUTBOX_STORE = 'outbox'
/** POD-7159 (version 2): the disk index. */
export const INDEX_STORE = 'disk-index'

/** Every store one transaction must be able to span. Order is irrelevant; completeness is not. */
export const ALL_STORES: readonly string[] = [ENTITY_STORE, META_STORE, OUTBOX_STORE, INDEX_STORE]

/**
 * Metadata keys are namespaced per principal by the compound key. The cursor,
 * the markers (one row per instance), the policy and the load state are
 * spelled once for every adapter in `replica/cache-state.ts`. Additive keys:
 * a version-1 store needs no migration, and a store without markers loads.
 */
export { CURSOR_META_KEY as CURSOR_KEY } from '../../replica/cache-state'

/** A cached entity row, as it is stored. `value` rides through structured clone. */
export interface StoredEntity {
  readonly principal: string
  readonly entity: string
  readonly entityId: string
  readonly value: unknown
  readonly revision?: number
  readonly provenance?: unknown
  /** `'stub'` for an issue held at stub level only; absent for a whole record. */
  readonly part?: 'stub'
  /** The feed number the row is current as of; absent means its provenance seq. */
  readonly asOf?: number
}

/** A `disk-index` row: a record's entry (key `entity\0id`) or an instance's state (key `\u0001<instance key>`). */
export interface StoredIndexRow {
  readonly principal: string
  readonly key: string
  readonly v: unknown
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
  readonly mutationId: MutationId
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
export function upgradeSchema(
  db: IdbDatabaseLike,
  upgrade?: {
    readonly transaction: IdbTransactionLike
    readonly oldVersion: number
    readonly keyRange?: IdbKeyRangeLike
    readonly onLegacyReset?: (principals: number) => void
  },
): void {
  if (!db.objectStoreNames.contains(ENTITY_STORE)) {
    db.createObjectStore(ENTITY_STORE, { keyPath: ['principal', 'entity', 'entityId'] })
  }
  if (!db.objectStoreNames.contains(META_STORE)) {
    db.createObjectStore(META_STORE, { keyPath: ['principal', 'key'] })
  }
  if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
    db.createObjectStore(OUTBOX_STORE, { keyPath: ['principal', 'mutationId'] })
  }
  // Version 2 (POD-7159). The index itself is built from the existing rows at
  // the first open that finds no `disk-index` flag (see `store.ts`), in normal
  // transactions, so a crash there repeats it and drops nothing.
  if (!db.objectStoreNames.contains(INDEX_STORE)) {
    db.createObjectStore(INDEX_STORE, { keyPath: ['principal', 'key'] })
  }
  if (upgrade === undefined || upgrade.oldVersion === 0 || upgrade.oldVersion >= 3) return
  // LEGACY(remove-after: 2027-05): schemas 1 and 2 accepted a pre-collection snapshot cursor; invalidating it here drops only cached data, retaining the outbox.
  const tx = upgrade.transaction
  const metadata = tx.objectStore(META_STORE).getAll()
  metadata.onsuccess = () => {
    const rows = metadata.result as StoredMeta[]
    const byPrincipal = new Map<string, StoredMeta[]>()
    for (const row of rows) {
      const group = byPrincipal.get(row.principal)
      if (group === undefined) byPrincipal.set(row.principal, [row])
      else group.push(row)
    }
    const incompatible = new Set<string>()
    for (const [principal, group] of byPrincipal) {
      const { cursor, policy } = decodeCacheMeta(group)
      if (cursor === null) continue
      const usablePolicy = policy?.steps.every(
        (step) =>
          step !== null &&
          typeof step === 'object' &&
          Array.isArray(step.collections) &&
          step.collections.every((id) => COLLECTIONS.has(id)),
      )
      if (!usablePolicy) incompatible.add(principal)
    }
    if (incompatible.size === 0) return
    // Invalidate cache and cursor together, in the version-change transaction.
    // The outbox and the other principals' compatible caches are independent.
    for (const principal of incompatible) {
      if (upgrade.keyRange !== undefined) {
        const range = upgrade.keyRange.bound([principal, ''], [principal, '\uffff'])
        for (const name of [ENTITY_STORE, META_STORE, INDEX_STORE])
          tx.objectStore(name).delete(range)
      }
    }
    if (upgrade.keyRange === undefined) {
      for (const name of [ENTITY_STORE, META_STORE, INDEX_STORE]) {
        const store = tx.objectStore(name)
        const request = store.getAll()
        request.onsuccess = () => {
          for (const row of request.result as (StoredEntity & StoredMeta & StoredIndexRow)[]) {
            if (!incompatible.has(row.principal)) continue
            store.delete(
              name === ENTITY_STORE
                ? [row.principal, row.entity, row.entityId]
                : [row.principal, row.key],
            )
          }
        }
      }
    }
    upgrade.onLegacyReset?.(incompatible.size)
  }
}
