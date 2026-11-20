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

import type { OwnedSyncSpan, SyncSpan } from '../span'
import type { DiskIndexReader } from './disk-index'
import type { StubTableReader } from './stub-table'
import type {
  BootstrapChunk,
  BootstrapRequired,
  CachePolicy,
  ChangeEnvelope,
  ChangeProvenance,
  Cursor,
  DeltaFrame,
  EntityRecord,
  InstanceRecord,
  InstanceRequest,
  KindTokens,
} from './types'

/**
 * ADR 2 D10's unit of work is defined ONCE, in `../span`, and re-exported here so
 * the replica's own modules keep importing it from their ports file (POD-1146).
 *
 * It is the single module this direction-locked role reaches outside its own
 * directory, pinned by name in `check-boundaries` rule 9. It sits outside because
 * the outbox role imports it too, and putting it here would have made the outbox
 * import the replica — the edge POD-369 and POD-370 deliberately removed.
 */
export type { OwnedSyncSpan, SyncSpan, SyncSpanParticipant, SyncUnitOfWork } from '../span'
export { SyncCommitConflict } from '../span'

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
      /** The row is an issue held at stub level only (design POD-7059 "Parts"). */
      readonly part?: 'stub'
      /**
       * The feed number this value is current as of. When set, the operation
       * applies only if it is NEWER than the row it replaces (`rowAsOf`), the
       * per-record ordering of fetch against feed; when absent it applies
       * unconditionally (a trim's downgrade, a test's hand-built batch).
       */
      readonly asOf?: number
      /** Write even over a row current as of the same number (a trim's downgrade keeps `asOf`). */
      readonly force?: true
      /**
       * POD-7159 — the main-part instances whose member the record is after
       * this change (instance keys), for the disk index. Absent keeps the
       * holders it had; a stub has none.
       */
      readonly holders?: readonly string[]
      /**
       * POD-7160 — the record is held only by instances on disk, none in
       * memory: it is written to disk, and to memory only when memory holds
       * the record when the write publishes (a disk load put it there
       * meanwhile). Its stub columns are kept current either way.
       */
      readonly diskOnly?: true
    }
  /** Tombstone (`op: 'remove'`) — the entity is gone, globally. */
  | {
      readonly kind: 'remove'
      readonly entity: string
      readonly entityId: string
      readonly asOf?: number
    }
  /** Visibility exit (`op: 'evict'`) — gone from THIS principal's view only. */
  | {
      readonly kind: 'evict'
      readonly entity: string
      readonly entityId: string
      readonly asOf?: number
    }

/**
 * One change to the device's MARKERS (POD-7086), in order, in the same
 * transaction as the rows they describe: an instance's marker is written
 * after its records, so a marker never claims a record the store lacks.
 */
export type InstanceOperation =
  /**
   * Write (or replace) the marker of one instance. `members` are the row keys
   * it holds (POD-7159, the disk index; added to what it held); without them
   * a main-part instance cannot be loaded from disk, only from the server.
   * `at` is when a view read it. A marker written this way is in memory: its
   * rows came with it.
   */
  | {
      readonly kind: 'mark'
      readonly instance: InstanceRecord
      readonly members?: readonly string[]
      readonly at?: number
    }
  /** Drop the marker of one instance (trimmed, or its holder left). */
  | { readonly kind: 'drop'; readonly key: string }
  /** Drop every marker: a feed gap that cannot be bridged, or the rights changed. */
  | { readonly kind: 'dropAll' }
  /** Note when a view released the instance; the trim drops the oldest release first. */
  | { readonly kind: 'release'; readonly key: string; readonly at: number }
  /**
   * POD-7160 — the instance's marker is behind the feed (a gap it could not
   * bridge): its rows stay, it reads from disk as usual, and a read reloads
   * it. A new `mark` clears it.
   */
  | { readonly kind: 'stale'; readonly key: string }
  /**
   * POD-7162 — the instance is being pruned: its members leave the device over
   * several slices, so a disk load cannot answer it any more (only the
   * server). `kept` are members something else keeps: they stay on the
   * device and stop being its members, so the next slice does not look at
   * them again. Its marker stays until its last member is gone (a `drop`); a
   * new `mark` makes it whole again.
   */
  | { readonly kind: 'pruning'; readonly key: string; readonly kept?: readonly string[] }

/**
 * Why the Replica's frame commit is multi-region at all, and why retirement
 * arrives as a BATCH: retirement used to be one call per applied change, and
 * inside a shared unit of work that is unsafe. Two retirements for one frame each
 * stage from the same pre-commit outbox snapshot, so the second RESURRECTS the
 * first — POD-370 reproduced exactly that. One certified frame routinely confirms
 * several of my own commands, so the Replica was handing the outbox precisely that
 * sequence. `SyncSpan.join`'s extend-the-one-draft idempotency is what closes it.
 */

/** One atomic batch. Everything in it commits together or not at all (ADR 2 D10, ADR 6 D4.1). */
/**
 * POD-7159 — what a record comes with, for the disk index (design POD-7157,
 * "What comes with a record is not a separate instance"): a row a record
 * brings (`held`), or the vias whose comes-with of a record is complete
 * (`complete`, replacing what it had). Applied after `instances`.
 */
export type ComesWithOperation =
  | { readonly kind: 'held'; readonly member: string; readonly holder: string }
  | { readonly kind: 'complete'; readonly record: string; readonly vias: readonly string[] }

export interface CacheMutation {
  /** Applied strictly in order. Adapters MUST NOT regroup or reorder. */
  readonly operations: readonly CacheOperation[]
  /** POD-7159 — comes-with changes for the disk index, after `instances`. */
  readonly comesWith?: readonly ComesWithOperation[]
  /** The cursor must never be ahead of the data it claims (ADR 2 D10). */
  readonly cursor?: Cursor
  /** Shape tokens bound to `cursor`; absent keeps the stored tokens on the same feed. */
  readonly kindTokens?: KindTokens
  /** Device-side kind-reload repair completed, bound to the same feed as the tokens. */
  readonly kindReloadVersion?: number
  /** Marker changes, applied after `operations`. */
  readonly instances?: readonly InstanceOperation[]
  /** The server's policy for this client (`syncMeta.policy`); null forgets it. */
  readonly policy?: CachePolicy | null
  /**
   * A load that replaces what the device held is under way at this feed
   * number (the first download, or a reload after a gap the feed cannot
   * bridge): rows current only as of an earlier number were not confirmed by
   * it yet. Null when the load has finished and swept them.
   */
  readonly loadingSince?: number | null
}

export interface SnapshotVersions {
  readonly kindTokens?: KindTokens
  readonly kindReloadVersion?: number
}

/**
 * The replica CACHE: entities + cursor + collection markers.
 * Everything on this port has a home at the authority and is re-derivable at will.
 *
 * TWO LAYERS (POD-7159, design POD-7157 "Layer 1", "Layer 2"). The disk keeps
 * every row the device has fetched; memory keeps the RESIDENT SET (the policy
 * collections and what they come with, the stub table, and what was loaded or
 * fetched since). Row reads are SYNCHRONOUS and answer resident rows only; the
 * disk index (`readDiskIndex`) says synchronously what is on disk. Rows on disk
 * and not in memory are read with `readDiskRows` and put in memory with
 * `installResident`; `unload` takes them out of memory again, never off disk.
 * Writes (`applyAtomic`) go to disk and memory together.
 */
export interface ReplicaCacheStore {
  readCursor(): Cursor | null
  readKindTokens(): KindTokens | undefined
  readKindReloadVersion(): number | undefined
  /**
   * Every stored marker, by instance key (`instanceKey`): what the device
   * holds on disk, in memory or not. `readDiskIndex().inMemory(key)` says
   * whether its rows are in memory.
   */
  readInstances(): ReadonlyMap<string, InstanceRecord>
  /**
   * POD-7159 — the disk index: every record and instance on disk, always in
   * memory, current with every published write.
   */
  readDiskIndex(): DiskIndexReader
  /**
   * POD-7159 — read rows from disk (not into memory), in one batched read,
   * after every write published so far is durable. A key with no row is left
   * out. Never a server request.
   */
  readDiskRows(keys: readonly string[]): Promise<readonly EntityRecord[]>
  /**
   * POD-7159 — put rows read from disk into memory. Memory only; nothing is
   * written. A row is skipped when it is not the one on disk any more (the
   * index has another feed number or level for it, or none) or memory holds
   * it already. Returns the rows put in memory.
   */
  installResident(rows: readonly EntityRecord[]): readonly EntityRecord[]
  /** POD-7159 — the instances' rows are in memory now: their markers answer `isComplete`. */
  markInMemory(instanceKeys: readonly string[]): void
  /**
   * POD-7159 — take instances out of memory, keeping them on disk: each
   * member no other in-memory instance holds leaves memory (its stub stays).
   * Returns the rows that left.
   */
  unload(instanceKeys: readonly string[]): readonly Pick<EntityRecord, 'entity' | 'entityId'>[]
  /** POD-7159 — a view read the instance (in memory only; the next release or mark writes it). */
  touchInstance(instanceKey: string, at: number): void
  /** The policy of the last first download; null before one started. */
  readPolicy(): CachePolicy | null
  /** The feed number of a load still under way; null when none is. */
  readLoadingSince(): number | null
  /**
   * Records with their main part, IN MEMORY (POD-7159). An issue held only as
   * its stub is NOT here, so a reader written for whole records never sees a
   * row without a title; stubs are read through {@link readStubs} and
   * {@link readRow}.
   */
  readEntities(): readonly EntityRecord[]
  /** A record with its main part in memory; `undefined` for a stub, a row only on disk, or an absent record. */
  read(entity: string, entityId: string): EntityRecord | undefined
  /** The one row of a record in memory, whatever its part: a stub or the record. */
  readRow(entity: string, entityId: string): EntityRecord | undefined
  /** Every row held only as a stub. */
  readStubs(): readonly EntityRecord[]
  /**
   * The stubs of `entity`, whole records and stubs alike, kept current with
   * every published write (POD-7115): the one copy of the stubs in memory.
   * `undefined` for a record type without a stub.
   */
  readStubTable(entity: string): StubTableReader | undefined
  /**
   * Open a span over the physical store this port is a view of (D10 clause 1).
   *
   * FOR THE ADAPTER, NOT FOR THE REPLICA (POD-1158). A storage adapter builds its
   * `SyncUnitOfWork` out of this; the Replica is handed `ReplicaParticipantStore`,
   * which omits it, so the Replica cannot open or settle a transaction. It used to
   * call this directly and commit synchronously, which made it impossible for an
   * asynchronous participant — every durable outbox store — to enrol at all.
   *
   * Opening a span here is still not a licence to reach the outbox: the span is an
   * opaque handle, so this port can enrol its own region in a shared commit without
   * gaining any way to name, read or clear another one. `discardCache()` still cannot
   * touch the outbox, which is the property this file exists to hold.
   */
  beginSpan(): OwnedSyncSpan
  /**
   * Apply a batch in ONE transaction. Throws `ReplicaStoreCorruptError` if unreadable.
   *
   * With a `span`, the batch is STAGED into that span's private draft and becomes
   * visible only when the span commits; repeated calls extend the one draft rather
   * than publishing twice (D10 clause 5). Without one, it autocommits — legal for a
   * lone single-region write (D10 clause 2).
   */
  applyAtomic(mutation: CacheMutation, span?: SyncSpan): void
  /**
   * Atomic replacement of every row (ADR 2 D6.4 / Amendment 1 D15.3): swap
   * staging into place, apply buffered deltas in order, commit the cursor — one
   * transaction; no window holding a mixture of two principals' slices. The
   * markers and policy are dropped with the rows they described. The Replica
   * installs collections in chunks through `applyAtomic` instead (POD-7086);
   * this stays the adapter's whole-store primitive.
   *
   * Takes a `span` for the same reason `applyAtomic` does: a bootstrap install that
   * includes buffered frames of my own commands must retire those commands in the
   * SAME commit as the slice it installs them onto.
   */
  installSnapshot(
    rows: readonly EntityRecord[],
    cursor: Cursor,
    buffered: readonly CacheMutation[],
    span?: SyncSpan,
    versions?: SnapshotVersions,
  ): void
  /** Discard entities, cursor, markers and policy. Cannot reach the outbox. */
  discardCache(): void
  /** ADR 6 D4 — surfaced, never silent. */
  durability(): 'durable' | 'degraded-memory' | 'unavailable'
}

/**
 * WHAT THE REPLICA IS HANDED: the cache port MINUS any way to open a transaction
 * (POD-1158, constraint 1).
 *
 * The Replica is a PARTICIPANT in a unit of work, never its owner. It receives a
 * `SyncSpan` — which carries no `commit` and no `abort` — from
 * `SyncUnitOfWork.transact`, and it must be structurally unable to obtain an
 * `OwnedSyncSpan` and settle a transaction somebody else composed. Omitting
 * `beginSpan` here is what makes that a type error rather than a comment.
 *
 * A storage adapter still implements the full `ReplicaCacheStore` — the physical
 * store legitimately opens spans, and that is how a `SyncUnitOfWork` is built over
 * it. It simply hands the Replica this narrower view. Structural typing means an
 * adapter needs no second class: the full port already satisfies this one.
 */
export type ReplicaParticipantStore = Omit<ReplicaCacheStore, 'beginSpan'>

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
  /**
   * Rung 1: certified frames toward one fixed target. Normal completion certifies
   * the target was reached; interruption throws. The consumer commits before
   * pulling again. Sources report the target before yielding the first frame.
   */
  changesRange(
    cursor: Cursor,
    signal?: AbortSignal,
    onTarget?: (target: Cursor, kindTokens: KindTokens) => void,
  ): Promise<AsyncIterable<DeltaFrame> | BootstrapRequired>
  /**
   * ADR 2 D6 / Amendment 1 D15 — the principal's slice, chunked and paced.
   * Pacing lives on the authority side of this port (D6: "the bootstrap must
   * never own the loop"); the Replica just consumes chunks as they arrive.
   */
  bootstrap(signal?: AbortSignal, view?: readonly InstanceRequest[]): AsyncIterable<BootstrapChunk>
  /**
   * POD-7085's one fetch route: the named instances, answered as of one feed
   * number, records and stubs in chunks and a marker per instance. The last
   * chunk carries `last: true` once the answer is complete. Optional so a
   * source that serves only the feed still satisfies the port; the Replica
   * then never resumes or fetches what a record comes with.
   */
  collections?(
    instances: readonly InstanceRequest[],
    signal?: AbortSignal,
  ): AsyncIterable<BootstrapChunk>
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
