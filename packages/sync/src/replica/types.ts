/**
 * Replica role — kernel vocabulary (ADR 2 + ADR 2 Amendment 1).
 *
 * These are the KERNEL's types, not the wire's. `packages/protocol` still speaks
 * the pre-cutover shape (`MetadataChangeOp = 'upsert' | 'remove'`, a bare integer
 * cursor, no covered range); POD-308 owns the wire cutover and the N/N-1 adapter
 * that maps that shape onto these. Defining them here is what lets the Replica be
 * a pure state machine over in-memory ports today, and what keeps the frame shape
 * ADR 2 Amendment 1 D13 requires from being blocked on the cutover.
 *
 * NO ARBITRATION, TWICE OVER (ADR 1 D1, ADR 2 Amendment 1 D12.7):
 *  - The Replica never decides authoritative truth. `revision` is an opaque,
 *    authority-assigned token it stores and echoes, never compares for truth.
 *  - The Replica never decides VISIBILITY. There is deliberately no principal,
 *    no grant, no owner and no visibility class in this file. The Authority
 *    computes the slice; the Replica applies it. If a type here ever needs to
 *    answer "may this principal see X", the design has drifted.
 */

import type {
  ChangeProvenanceFields,
  ChangeTargetFields,
  ChangeOp as ModelChangeOp,
} from '@podium/model'

/**
 * ADR 2 D1 — a cursor is meaningless without feed identity. Never a bare integer.
 * `epoch` is an opaque never-reused generation id compared by EQUALITY ONLY
 * (D1: a counter re-collides across repeated restores of the same backup).
 */
export interface Cursor {
  readonly feedId: string
  readonly epoch: string
  readonly seq: number
}

export type KindTokens = Readonly<Record<string, string>>

/**
 * The removal family, all three members (ADR 2 D5 + Amendment 1 D14.5). D5 warns
 * that soft-delete and tombstone "look identical from a distance and are not";
 * `evict` is the third member and must not be collapsed into the second.
 *
 *  | wire                     | means                              | scope         | reversible |
 *  |--------------------------|------------------------------------|---------------|------------|
 *  | `upsert` w/ `deletedAt`  | domain soft-delete, recoverable    | global        | by domain  |
 *  | `remove`                 | tombstone — the entity is gone     | global        | no         |
 *  | `evict`                  | gone from YOUR VIEW — it exists    | per-principal | by grant   |
 *
 * Alias of `@podium/model`'s {@link ModelChangeOp} — not a second union of the
 * same three literals (POD-1251). The model builds the full vocabulary by
 * EXTENDING the global ops, so "is this op global?" has one answer.
 */
export type ChangeOp = ModelChangeOp

/**
 * ADR 2 D8 — origin, causation and mutation identity ride the ENVELOPE, never the
 * entity payload. Putting them in the payload would make byte-equality dedup fire
 * on provenance churn and would drag provenance into every wire projection
 * (ADR 4 forbids it).
 *
 * The model's {@link ChangeProvenanceFields}, not a second spelling of the triple.
 */
export type ChangeProvenance = ChangeProvenanceFields

/**
 * One row of the feed, as the Replica sees it.
 *
 * COMPOSED from the model field groups (POD-1251), not restated as a fresh
 * interface. The payload arm is named `payload` here (the wire and the staged
 * lifecycle say `value`) — that rename is deliberate at the replica boundary
 * and is the one thing this type adds rather than borrows. Split across
 * intersections so no single brace block rewrites the change-row field list.
 */
export type ChangeEnvelope = ChangeProvenance &
  ChangeTargetFields & { readonly seq: number } & { readonly op: ChangeOp } & {
    /** Present iff `op === 'upsert'`. `remove` and `evict` carry none. */
    readonly payload?: unknown
  } & {
    /** ADR 2 D3 — authority-assigned, opaque to the Replica. */
    readonly revision?: number
  }

/**
 * ADR 2 Amendment 1 D13 — every delta frame and every catch-up reply certifies a
 * COVERED RANGE. Its normative meaning, in one sentence:
 *
 *   "I have evaluated every global seq in (fromSeq, seq] against your principal,
 *    and `changes` contains exactly those you may see."
 *
 * An empty `changes` array is a WATERMARK. It is the normal path under
 * private-by-default, not an exception — which is why it is the same frame on the
 * same ordered pipe rather than a second control message (D13's rejected
 * alternatives; `funnel.ts:45` makes single-emitter ordering the correctness
 * property).
 */
export interface DeltaFrame {
  readonly kind: 'delta'
  readonly feedId: string
  readonly epoch: string
  /** Exclusive lower bound of the certified range. */
  readonly fromSeq: number
  /** Inclusive upper bound. */
  readonly seq: number
  /**
   * ADR 2 D5 — the lowest seq the authority still RETAINS, advertised on every
   * frame "so a replica can tell 'I need to re-bootstrap'" without spending a
   * round trip to be told.
   *
   * REQUIRED, and that is the decision rather than an oversight. An optional
   * field here would be read as `?? 0` at every use site, and `0` is precisely
   * the value that says "nothing has been pruned, your cursor is fine" — so an
   * authority that forgot to publish it would be indistinguishable from one whose
   * log is complete, and rung 2 would silently never fire. That is the
   * fails-OPEN shape this run has paid for three times: the check is present, its
   * refusing arm is unreachable, and deleting it changes nothing. Making the
   * field required moves "the authority publishes this" from a hope to a compile
   * error, and `validateFrame` rejects a non-integer or out-of-range value so a
   * hand-built frame cannot slip past the type either.
   */
  readonly minAvailableSeq: number
  /** Every change in `(fromSeq, seq]` this principal may see, in seq order. MAY be empty. */
  readonly changes: readonly ChangeEnvelope[]
  /**
   * The principal's access moved in this range (POD-6947, `ScopedDelivery`):
   * decisions taken against the old access are taken again. The replica's
   * apply rule ignores it; the live-topic holder re-asks what it was refused.
   */
  readonly access?: true
}

/**
 * ADR 2 Amendment 1 D14.4 — a per-principal control frame meaning "your rights
 * changed"; resolves to D7 rung 2 (re-bootstrap, scoped). Distinct from
 * `resync-required` IN TELEMETRY as well as in type: collapsing them makes an
 * authz event look like a performance event.
 */
export interface RescopeFrame {
  readonly kind: 'rescope'
  readonly feedId: string
  readonly epoch: string
  readonly reason?: string
}

/** ADR 2 D9 — the authority shed load; also rung 2. */
export interface ResyncRequiredFrame {
  readonly kind: 'resync-required'
  readonly feedId: string
  readonly epoch: string
  readonly reason?: string
}

export type ServerFrame = DeltaFrame | RescopeFrame | ResyncRequiredFrame

/** The authority cannot serve a delta from this cursor (compacted / unknown). */
export interface BootstrapRequired {
  readonly kind: 'bootstrap-required'
  readonly reason?: string
}

export type ChangesSinceReply = DeltaFrame | BootstrapRequired

/**
 * ADR 2 D6 / Amendment 1 D15 — bootstrap is a chunked stream of the same change
 * shape, read at a definite `(feedId, epoch, snapshotSeq)`. The snapshot is the
 * PRINCIPAL'S SLICE, which is an authority-side fact: nothing in this type names
 * a principal, because the Replica must not be able to influence what is in it.
 *
 * A snapshot is POSITIVE STATE (D5's safety proof): it lists what exists and is
 * visible. A deleted entity is absent; an entity this principal may not see is
 * ALSO absent — which is exactly why a missed `evict` heals the same way a missed
 * tombstone heals (Amendment 1 D16.1).
 */
export interface BootstrapChunk {
  readonly feedId: string
  readonly epoch: string
  readonly snapshotSeq: number
  /** Positive state only — `upsert` rows. A `remove`/`evict` here is malformed. */
  readonly changes: readonly ChangeEnvelope[]
  /**
   * Issues at stub level (POD-7085 `feedStubs`): `upsert` rows of the issue
   * kind whose payload is the declared stub fields only.
   */
  readonly stubs?: readonly ChangeEnvelope[]
  /**
   * Markers (POD-7085 `collectionComplete`): every record of these instances
   * this viewer may see arrived in this answer at or before this chunk, as of
   * `snapshotSeq`.
   */
  readonly complete?: readonly CompleteMarker[]
  /** The first download's policy (`syncMeta.policy`), on its first chunk. */
  readonly policy?: CachePolicy
  readonly last: boolean
  /** Transfer header metadata, certified when the last chunk arrives. */
  readonly kindTokens: KindTokens
}

/** One instance a marker names, with a paged instance's range and first-page total. */
export interface CompleteMarker extends InstanceSpec {
  readonly range?: InstanceRange
  readonly total?: number
}

/** An instance as a fetch asks for it: a paged one may continue below a position. */
export interface InstanceRequest extends InstanceSpec {
  readonly after?: readonly InstanceScalar[]
}

/**
 * The Replica's posture. `stale` is ADR 2 D7's "stale-visible, never blank":
 * a disconnected replica keeps serving its last-known slice. Under scoping that
 * slice may include rows a revocation has since removed — see
 * `docs/spec/replica-state-machine.md` §5. That is a stale read, not a leak, and
 * it is NOT corrected locally: expiring visibility on a timer would be the
 * Replica arbitrating.
 */
export type Posture =
  /** No slice installed, not connected. */
  | 'cold'
  /** Walking a chunked bootstrap; concurrent frames are buffered. */
  | 'bootstrapping'
  /** Cursor valid, connected, applying frames. */
  | 'live'
  /** Gap detected (rung 1); a `changesRange` is in flight. */
  | 'healing'
  /** Disconnected, holding the last-known slice. Visible, marked stale. */
  | 'stale'

/** ADR 2 D7's ladder. Rung 0 is the normal path; rungs 2-6 all terminate at re-bootstrap. */
export type HealRung = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * Why a re-bootstrap happened. Every one of these goes through the SAME code path
 * (`Replica.rebootstrap`), which is what makes "discard the cache, re-bootstrap,
 * keep the outbox" a property of one function rather than of six call sites.
 */
export type RebootstrapCause =
  /** rung 2 — cursor below `minAvailableSeq`, or the authority said so. */
  | 'compacted'
  /** rung 2 — ADR 2 D9 backpressure demotion. */
  | 'resync-required'
  /** rung 2 — Amendment 1 D14.4: the principal's rights changed. */
  | 'rescope'
  /** rung 3 — malformed frame or non-contiguous reply. */
  | 'malformed'
  /** rung 4 — feedId/epoch mismatch (D1). */
  | 'epoch-mismatch'
  /** rung 5 — local store unreadable. */
  | 'local-corruption'
  /** rung 6 — replica schema version bump (D4). */
  | 'schema-version'
  /** A wire schema, publication rule, or stored generation changed. */
  | 'kind-shape'
  /** rung 2 — a cold client has no cursor to heal from. */
  | 'cold-start'
  /**
   * rung 2 — a first download or reload was interrupted: the collections
   * without a marker load again (POD-7086), nothing else.
   */
  | 'resume'

/**
 * An entity as the Replica holds it: value, opaque revision, and envelope provenance beside it — never inside it.
 *
 * ONE ROW PER RECORD (POD-7086, design POD-7059 "Parts"): an issue the device
 * holds only as its stub carries `part: 'stub'` and only the declared stub
 * fields; every other row is the record with its main part. `asOf` is the
 * feed number the row is current as of: a fetched answer can be ahead of the
 * feed the device has applied, so a change older than this is skipped for
 * this row ("the newer one wins, per record"). Absent, it is the provenance seq.
 */
export interface EntityRecord {
  readonly entity: string
  readonly entityId: string
  readonly value: unknown
  readonly revision?: number
  readonly provenance: ChangeProvenance & { readonly seq: number }
  readonly part?: 'stub'
  readonly asOf?: number
}

/** The feed number a row is current as of. */
export const rowAsOf = (row: Pick<EntityRecord, 'asOf' | 'provenance'>): number =>
  row.asOf ?? row.provenance.seq

/** A value inside an instance's arguments. */
export type InstanceScalar = string | number | boolean | null

/** The arguments of one instance ("the tree under X": `{ root: X }`). */
export type InstanceArgs = Readonly<Record<string, InstanceScalar | readonly InstanceScalar[]>>

/**
 * One INSTANCE of a declared collection (`@podium/model` `records/`): the
 * collection with its arguments filled in, the part it holds, and for a
 * keyed instance that arrives because another record is held, the holder
 * (`via`) whose "comes with" narrows it. The kernel's spelling of the wire's
 * `CompleteInstance`; nothing here names a principal or a right.
 */
export interface InstanceSpec {
  readonly collection: string
  readonly args?: InstanceArgs
  readonly part: 'stub' | 'main'
  readonly via?: string
}

/** A sorted, paged instance's range: complete from the top down to `through`, or to its end. */
export interface InstanceRange {
  readonly through?: readonly InstanceScalar[]
  readonly end: boolean
}

/**
 * The MARKER, as the device stores it: "this instance is complete", as of
 * `completeAt`. Because the feed is applied without gaps, a complete instance
 * stays complete; a gap that cannot be bridged drops every marker.
 * `releasedAt` orders cache instances for the trim (released longest ago
 * goes first); absent means never released.
 */
export interface InstanceRecord extends InstanceSpec {
  readonly key: string
  readonly range?: InstanceRange
  /** A paged instance's first page: the whole instance's size for this viewer. */
  readonly total?: number
  readonly completeAt: Cursor
  readonly releasedAt?: number
}

/**
 * What a screen asks the device about its collections (POD-7086; the readers
 * move onto it in POD-7088). Synchronous, from memory. A stub is never in
 * `readEntities()`/`read()`, so a reader written for whole records never sees
 * a row without a title; it reads stubs here.
 */
export interface DeviceCollectionReads {
  /** The marker of an instance the device holds complete; `undefined` when it does not. */
  isComplete(spec: InstanceSpec): InstanceRecord | undefined
  /** The stub part of an issue the device holds, as a stub or whole; `undefined` when absent. */
  stubOf(entity: string, entityId: string): Readonly<Record<string, unknown>> | undefined
  /** The ids of the issues on the device whose parent is `parentId`, stubs included. */
  stubsByParent(parentId: string): readonly string[]
  /**
   * The stub part of every record of `entity` on the device, stubs and whole
   * records alike (POD-7087, design "Counts"). The same array until the
   * device's rows change.
   */
  stubRows(entity: string): readonly StubRow[]
}

/** One record's stub part, by id. */
export interface StubRow {
  readonly id: string
  readonly stub: Readonly<Record<string, unknown>>
}

/** The server's policy for this client type, as the device stores it (`syncMeta.policy`). */
export interface CachePolicy {
  readonly clientType: string
  readonly steps: readonly { readonly step: string; readonly collections: readonly string[] }[]
  readonly recentDays: number
  /** Records held as cache beyond the policy's collections. */
  readonly cacheCap: number
}

/**
 * How an entity left the view. This is the model-level distinction ADR 2
 * Amendment 1 D14.5 requires: a consumer must be able to tell "someone unshared
 * this" from "someone deleted this" without guessing.
 */
export type ExitKind = 'removed' | 'evicted'

export type ReplicaEvent =
  | { readonly type: 'upserted'; readonly record: EntityRecord; readonly readmitted: boolean }
  /**
   * The device no longer holds the record whole (POD-7086): the trim or the
   * end of a load let it go, or took an issue back to its stub. NOT a
   * deletion and not a visibility change: a lookup now answers "on its way".
   */
  | { readonly type: 'released'; readonly entity: string; readonly entityId: string }
  /** An issue's stub was written: the device holds it at stub level only. */
  | { readonly type: 'stub-upserted'; readonly record: EntityRecord }
  /**
   * Markers were written or dropped (POD-7087): what `isComplete` answers
   * may have changed. Touches no row.
   */
  | { readonly type: 'markers' }
  /** A TOMBSTONE. The entity is gone, globally. Render as deleted. */
  | { readonly type: 'removed'; readonly entity: string; readonly entityId: string }
  /**
   * A VISIBILITY change. The entity still exists for others; it left this
   * principal's view. MUST NOT render as a deletion, MUST NOT emit a domain
   * "deleted" event, MUST NOT write a tombstone (D14.1).
   */
  | { readonly type: 'evicted'; readonly entity: string; readonly entityId: string }
  | { readonly type: 'cursor'; readonly cursor: Cursor; readonly watermarkOnly: boolean }
  | { readonly type: 'posture'; readonly posture: Posture; readonly previous: Posture }
  | {
      readonly type: 'heal-progress'
      readonly framesCommitted: number
      readonly seq: number
      /** The cursor seq this catch-up started from, so progress is measured, not guessed. */
      readonly fromSeq: number
      /** Fixed source target; undefined only for sources without target metadata. */
      readonly targetSeq: number | undefined
    }
  | {
      readonly type: 'heal'
      readonly rung: HealRung
      readonly cause: RebootstrapCause | 'gap'
      readonly partial?: true
    }
  /**
   * POD-7122 — a load's records and markers are all in the device store's
   * memory: every policy collection, with what its records come with. Views
   * may open on them now. Its durable commit follows as `bootstrap-installed`,
   * which alone moves the posture live; a crash before it resumes the load.
   */
  | {
      readonly type: 'load-installed'
      readonly cause: RebootstrapCause
      readonly snapshotSeq: number
    }
  | {
      readonly type: 'bootstrap-installed'
      readonly cause: RebootstrapCause
      readonly snapshotSeq: number
      readonly entityCount: number
      readonly bufferedFramesApplied: number
      /** A filtered install reports the cached addresses absent from the new slice. */
      readonly dropped?: readonly Pick<EntityRecord, 'entity' | 'entityId'>[]
    }
  /** Surfaced, never swallowed. The prior slice stays visible (D7 stale-visible). */
  | {
      readonly type: 'bootstrap-failed'
      readonly cause: RebootstrapCause
      readonly attempts: number
      readonly error: string
    }

/** Observable counters. Used by conformance to prove state stays BOUNDED (D13.4). */
export interface ReplicaStats {
  /** Frames held during a bootstrap walk. MUST be 0 outside `bootstrapping`. */
  readonly bufferedFrames: number
  readonly bufferedChanges: number
  /**
   * Deliberately capped at 1 by construction: there is no pending-gap SET.
   * A gap resolves downward immediately (rung 1 → heal → rung 2 if that fails),
   * so a watermark-only stretch cannot accumulate anything here.
   */
  readonly pendingGaps: number
  readonly heals: number
  readonly bootstraps: number
  readonly framesApplied: number
  readonly watermarksApplied: number
  /** Cache trims run (POD-7165: one once the fetches in flight are done, not one per answer). */
  readonly trims: number
  readonly entityCount: number
}
