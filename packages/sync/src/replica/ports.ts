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
  ChangeEnvelope,
  ChangeProvenance,
  ChangesSinceReply,
  Cursor,
  EntityRecord,
} from './types'

/**
 * ONE operation against the cache, in FEED ORDER.
 *
 * This is a list and not three buckets, and that is load-bearing. An earlier
 * shape partitioned a frame into upserts/removals/evictions, which silently
 * reordered them: `remove(seq 1)` followed by `upsert(seq 2)` for one entity
 * applied the upsert first and then deleted it, so a re-created entity ended up
 * ABSENT. Feed order IS the correctness property (ADR 2 D9: "order is the
 * correctness property"; D13: "apply changes in seq order"), and a port that
 * cannot express it hands every adapter the same bug. Keeping the three kinds as
 * a discriminated union rather than a flag also keeps `remove` and `evict`
 * distinguishable all the way down (Amendment 1 D14.5).
 */
export type CacheOperation =
  | {
      readonly kind: 'upsert'
      readonly entity: string
      readonly entityId: string
      readonly value: unknown
      readonly revision?: number
      readonly provenance: ChangeProvenance & { readonly seq: number }
    }
  /** Tombstone (`op: 'remove'`) — the entity is gone, globally. */
  | { readonly kind: 'remove'; readonly entity: string; readonly entityId: string }
  /** Visibility exit (`op: 'evict'`) — gone from THIS principal's view only. */
  | { readonly kind: 'evict'; readonly entity: string; readonly entityId: string }

/** One atomic batch. Everything in it commits together or not at all (ADR 2 D10, ADR 6 D4.1). */
export interface CacheMutation {
  /** Applied strictly in order. Adapters MUST NOT regroup or reorder. */
  readonly operations: readonly CacheOperation[]
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

/**
 * The KNOWN-KIND validation seam (ADR 2 D7 rung 3 + D4's lenient-parsing rule).
 *
 * D7 rung 3 fires on "known-kind row fails validation, corrupt payload, id
 * mismatch". The Replica cannot perform any of those checks itself: a payload is
 * `unknown` here by design, because knowing an entity's schema would mean knowing
 * the domain, and the whole point of D4's lenient parsing is that a replica which
 * does NOT know a kind must still advance its cursor past it rather than
 * quarantining it into an invisible permanent gap.
 *
 * So the check is injected. Whoever knows the schemas (POD-308's wire adapter,
 * POD-351's contracts) supplies this; the kernel supplies neither, and the
 * direction lint stops it from importing one.
 *
 * The asymmetry is the decision: **unknown kinds are lenient, known kinds are
 * strict.** A validator that claims to know a kind takes on the obligation to
 * reject a corrupt one; a validator that does not know a kind must let it
 * through, cursor and all.
 */
export interface KnownKindValidatorPort {
  /** Does this replica know this entity kind's schema? */
  knows(entity: string): boolean
  /**
   * Validate a change of a KNOWN kind — payload shape, and any id embedded in
   * the payload against the envelope's `entityId` (the #247-round-2 rule ADR 2
   * D7 ratifies as protocol law). Return a reason to reject, or null to accept.
   */
  validate(change: ChangeEnvelope): string | null
}
