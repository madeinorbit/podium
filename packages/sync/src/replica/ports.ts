/**
 * Replica ports (ADR 6 D3 — one storage port, platform adapters behind it).
 *
 * THE OUTBOX IS NOT ON THIS PORT, AND THAT IS THE POINT.
 *
 * ADR 2 D7 calls it the most dangerous sentence in the ADR: ADR 6 co-locates
 * entities, cursor, overlay AND the outbox in one transactional store, so
 * "clear the store" reads as one innocent operation and is in fact two — throwing
 * away a CACHE, which is free, and throwing away THE USER'S UNSENT WRITES, which
 * is data loss. Before multi-user that only fired on epoch bumps and corruption.
 * Under private-by-default a `rescope` fires whenever somebody's shares change
 * (Amendment 1 D14.4), so a drop-the-outbox bug is now reachable by a colleague
 * clicking "share".
 *
 * The defence here is structural rather than disciplinary: `ReplicaCacheStore`
 * has no outbox method, so `discardCache()` CANNOT reach the outbox — not
 * "must not", cannot. A storage adapter implements both ports over one physical
 * store and one transaction (ADR 6 D4.1); it hands the Replica only this one.
 * ADR 3 D9 invariant 5 says the same thing from the command side.
 */

import type {
  BootstrapChunk,
  ChangeProvenance,
  ChangesSinceReply,
  Cursor,
  EntityRecord,
} from './types'

/** One atomic batch. Everything in it commits together or not at all (ADR 2 D10, ADR 6 D4.1). */
export interface CacheMutation {
  readonly upserts?: readonly {
    readonly entity: string
    readonly entityId: string
    readonly value: unknown
    readonly revision?: number
    readonly provenance: ChangeProvenance & { readonly seq: number }
  }[]
  /** Tombstones (`op: 'remove'`). */
  readonly removals?: readonly { readonly entity: string; readonly entityId: string }[]
  /** Visibility exits (`op: 'evict'`). Separate from `removals` all the way down. */
  readonly evictions?: readonly { readonly entity: string; readonly entityId: string }[]
  /** The cursor must never be ahead of the data it claims (ADR 2 D10). */
  readonly cursor?: Cursor
}

/**
 * The replica CACHE: entities + cursor (+ overlay, once POD-370 lands it).
 * Everything on this port has a home at the authority and is re-derivable at will.
 */
export interface ReplicaCacheStore {
  readCursor(): Cursor | null
  readEntities(): readonly EntityRecord[]
  read(entity: string, entityId: string): EntityRecord | undefined
  /** Apply a batch in ONE transaction. Throws `ReplicaStoreCorruptError` if unreadable. */
  applyAtomic(mutation: CacheMutation): void
  /**
   * Atomic install of a bootstrap (ADR 2 D6.4 / Amendment 1 D15.3): swap staging
   * into place, apply buffered deltas in order, commit the cursor — one
   * transaction, no half-installed replica, no window holding a mixture of two
   * principals' slices.
   */
  installSnapshot(
    rows: readonly EntityRecord[],
    cursor: Cursor,
    buffered: readonly CacheMutation[],
  ): void
  /** Discard the cache. Reaches entities and cursor. Cannot reach the outbox. */
  discardCache(): void
  /** ADR 6 D4 — surfaced, never silent. */
  durability(): 'durable' | 'degraded-memory' | 'unavailable'
}

/**
 * Thrown by a store whose contents cannot be read or written (ADR 2 D7 rung 5).
 * The Replica responds by discarding the cache and re-bootstrapping cold — and
 * the outbox's own store reports its loss separately and LOUDLY, because that is
 * the one case where user work is lost.
 */
export class ReplicaStoreCorruptError extends Error {
  constructor(message = 'replica store unreadable') {
    super(message)
    this.name = 'ReplicaStoreCorruptError'
  }
}

/**
 * The read side of the authority, as the Replica sees it.
 *
 * There is no `principal` parameter anywhere on this port, deliberately. ADR 3 D7
 * takes the principal from the authenticated transport ONLY; a principal argument
 * here would be payload identity, and it would also hand the Replica a lever over
 * its own slice — the exact drift Amendment 1 D12.7 forbids.
 */
export interface AuthorityReadPort {
  /** ADR 2 D7 rung 1's heal. Returns a certified reply, or "you must re-bootstrap". */
  changesSince(cursor: Cursor): Promise<ChangesSinceReply>
  /**
   * ADR 2 D6 / Amendment 1 D15 — the principal's slice, chunked and paced.
   * Pacing lives on the authority side of this port (D6: "the bootstrap must
   * never own the loop"); the Replica just consumes chunks as they arrive.
   */
  bootstrap(): AsyncIterable<BootstrapChunk>
}
