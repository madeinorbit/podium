import { z } from 'zod'

/**
 * The control port's scoped-feed vocabulary — ADR 2 Amendment 1 D13/D14, whose
 * transport classification is ADR 7 Amendment 1 D16.3 (both C/e; neither may be
 * stream).
 *
 * SEMANTICS ARE ADR 2's. This module is the PORT's expression of them: the
 * covered range that makes contiguity hold over a filtered view, the third
 * member of the delete family (`evict`), and the `rescope` control frame. The
 * scoped-feed KERNEL is Phase 2 (POD-1077) and is deliberately not built here;
 * the wire landing of these fields on `metadataDelta` / `MetadataChangeOp` is
 * POD-1077's, negotiated by capability rather than a `WIRE_VERSION` bump
 * (ADR 2 D4).
 */

/**
 * ADR 2 D1's cursor triple, unchanged by scoping: global `seq` stays GLOBAL and
 * visibility is the only per-principal quantity in the protocol (D12).
 */
export const FeedCursor = z.object({
  feedId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
})
export type FeedCursor = z.infer<typeof FeedCursor>

/**
 * The change-op vocabulary of the scoped feed. `evict` is a THIRD member of the
 * soft-delete / tombstone family, not a synonym for `remove` (ADR 2 D14.5,
 * ADR 2 D5's warning arriving a third time).
 */
export const SCOPED_CHANGE_OPS = ['upsert', 'remove', 'evict'] as const
export type ScopedChangeOp = (typeof SCOPED_CHANGE_OPS)[number]
export const ScopedChangeOp = z.enum(SCOPED_CHANGE_OPS)

export interface ChangeOpSemantics {
  /** What a replica must render. */
  readonly means: string
  /** Global to every replica, or only this principal's view? */
  readonly scope: 'global' | 'per-principal'
  readonly reversible: boolean
  /** Does the replica write a tombstone? */
  readonly tombstone: boolean
  /** May the replica emit a domain "deleted" event? */
  readonly deletedEvent: boolean
}

/**
 * ADR 2 D14.5's table as data, so "reuse `remove` for eviction" is a type error
 * away from being written rather than a paragraph away from being noticed.
 */
export const CHANGE_OP_SEMANTICS = {
  upsert: {
    means: 'this is the entity’s current wire value',
    scope: 'global',
    reversible: true,
    tombstone: false,
    deletedEvent: false,
  },
  remove: {
    means: 'gone from your replica — the entity no longer exists',
    scope: 'global',
    reversible: false,
    tombstone: true,
    deletedEvent: true,
  },
  evict: {
    // "gone from YOUR VIEW — it exists, for others". The replica drops the
    // entity from its cache and derived views, must NOT surface it as a
    // deletion, must not emit a domain deleted event, and must not write a
    // tombstone. Re-admission is an ordinary `upsert` (D14.2).
    means: 'gone from your view — it exists, for others',
    scope: 'per-principal',
    reversible: true,
    tombstone: false,
    deletedEvent: false,
  },
} as const satisfies Record<ScopedChangeOp, ChangeOpSemantics>

/**
 * One scoped change. `evict` carries an entity kind and id and NO payload
 * (D14.1); the shape is the port's, and the entity-typed union on the wire is
 * `MetadataChange`'s (POD-1077 adds the op there).
 */
export const ScopedChange = z.object({
  seq: z.number().int().positive(),
  entity: z.string().min(1),
  id: z.string().min(1),
  op: ScopedChangeOp,
  /** Present iff `op === 'upsert'`; `evict` and `remove` carry none. */
  value: z.unknown().optional(),
})
export type ScopedChange = z.infer<typeof ScopedChange>

/**
 * THE WATERMARK MECHANISM (ADR 2 D13). Every delta frame certifies a covered
 * range; a watermark is that same frame with an EMPTY change list, on the
 * funnel's one ordered pipe — not a new message class, and never stream (a lost
 * watermark is an invisible permanent gap, the failure ADR 2 D2 documents).
 *
 *   "I have evaluated every global seq in (fromSeq, seq] against your
 *    principal, and `changes` contains exactly those you may see."
 */
export const ScopedDeltaFrame = z.object({
  feedId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  /** Exclusive lower bound of the certified range. */
  fromSeq: z.number().int().nonnegative(),
  /** Inclusive upper bound — the batch stamp. */
  seq: z.number().int().nonnegative(),
  /** Every visible change in `(fromSeq, seq]`, in `seq` order. MAY be empty. */
  changes: z.array(ScopedChange),
})
export type ScopedDeltaFrame = z.infer<typeof ScopedDeltaFrame>

/** A watermark is a certified frame with nothing visible in its range. */
export const isWatermarkFrame = (frame: ScopedDeltaFrame): boolean => frame.changes.length === 0

/**
 * The replica acceptance rule, replacing "the first change's seq must be
 * cursor + 1": accept iff `fromSeq === cursor` (and feedId/epoch match).
 * Strictly STRONGER than the rule it replaces — an explicit lower bound also
 * catches a frame that vanished between two accepted ones.
 */
export const acceptsAtCursor = (cursor: FeedCursor, frame: ScopedDeltaFrame): boolean =>
  cursor.feedId === frame.feedId && cursor.epoch === frame.epoch && cursor.seq === frame.fromSeq

/**
 * Watermark-only frames may be coalesced by RANGE EXTENSION only: two adjacent
 * certified ranges merge, and a run of watermarks collapses to one frame
 * without loss (D13.2). Merging may never reorder, drop, or merge out of order
 * a frame containing visible changes (D13.3) — hence the guard.
 */
export const coalesceCertifiedRanges = (
  first: ScopedDeltaFrame,
  second: ScopedDeltaFrame,
): ScopedDeltaFrame | null => {
  if (first.feedId !== second.feedId || first.epoch !== second.epoch) return null
  if (first.seq !== second.fromSeq) return null
  if (first.changes.length > 0 && second.changes.length > 0) return null
  return {
    feedId: first.feedId,
    epoch: first.epoch,
    fromSeq: first.fromSeq,
    seq: second.seq,
    changes: [...first.changes, ...second.changes],
  }
}

/**
 * `rescope` — the per-principal control frame that resolves to rung 2 of
 * ADR 2 D7's ladder (re-bootstrap, scoped). Always legal in place of
 * enumerated evict/upsert rows (D14.4).
 *
 * It is NOT `resync-required` (which means the authority shed load) and NOT the
 * stream-plane `presenceRoomClosed` (which only stops a fan-out). The three must
 * stay distinguishable in telemetry, or a policy change reads as backpressure.
 */
export const RescopeFrame = z.object({
  type: z.literal('rescope'),
  feedId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  /** The seq the rights change occupies in the global log (D14.3). */
  seq: z.number().int().nonnegative(),
  /**
   * Fixed discriminator against `resync-required`. Rights changed; the
   * authority did not shed load.
   */
  cause: z.literal('rights-changed'),
})
export type RescopeFrame = z.infer<typeof RescopeFrame>

export const ScopedFeedServerMessage = z.discriminatedUnion('type', [RescopeFrame])
export type ScopedFeedServerMessage = z.infer<typeof ScopedFeedServerMessage>

/**
 * The outbox survives `rescope` exactly as it survives every other rung of the
 * ladder (D14.4): a rights change is not a licence to discard queued writes.
 * Stated as data so a port implementation can assert it.
 */
export const RESCOPE_PRESERVES_OUTBOX = true
