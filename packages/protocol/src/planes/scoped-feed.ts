import { CHANGE_OPS, ChangeOpField } from '@podium/model'
import { z } from 'zod'
import { changeRowArm } from '../messages/change-row'

/**
 * The control port's scoped-feed vocabulary — ADR 2 Amendment 1 D13/D14, whose
 * transport classification is ADR 7 Amendment 1 D16.3 (both C/e; neither may be
 * stream).
 *
 * SEMANTICS ARE ADR 2's. This module is the PORT's expression of them: the
 * covered range that makes contiguity hold over a filtered view, the third
 * member of the delete family (`evict`), and the `rescope` control frame. The
 * scoped-feed KERNEL is Phase 2 (POD-1077); the WIRE landing of these fields is
 * POD-308's cutover, and it lands them as their own frame family
 * (`../messages/feed.ts`) rather than by widening `metadataDelta` — see that
 * file's header for why the pre-cutover frame could not carry them.
 */

/**
 * The feed's seq-continuity generation, as the WIRE spells it (ADR 2 D1).
 *
 * A STRING, and that is the decision rather than a convenience. D1 forbids a
 * counter outright — restoring one backup twice re-mints the same value and hands
 * a different timeline an epoch clients have already accepted — and
 * `@podium/sync`'s `FeedIdentityRegistry.assertOpaqueEpoch` REFUSES a decimal
 * integer at the minting boundary. This port previously declared
 * `z.number().int()`, which is precisely the shape that guard exists to reject:
 * the two could never have met, and the wire would have been the place they
 * failed to. Corrected at the cutover (POD-308) because the cutover is the first
 * moment an epoch actually crosses the wire.
 *
 * Compared by EQUALITY ONLY. There is no ordering on an epoch anywhere.
 */
export const FeedEpochField = z.string().min(1)

/**
 * ADR 2 D1's cursor triple, unchanged by scoping: global `seq` stays GLOBAL and
 * visibility is the only per-principal quantity in the protocol (D12).
 */
export const FeedCursor = z.object({
  feedId: z.string().min(1),
  epoch: FeedEpochField,
  seq: z.number().int().nonnegative(),
})
export type FeedCursor = z.infer<typeof FeedCursor>

/**
 * The change-op vocabulary of the scoped feed. `evict` is a THIRD member of the
 * soft-delete / tombstone family, not a synonym for `remove` (ADR 2 D14.5,
 * ADR 2 D5's warning arriving a third time).
 *
 * THE MODEL'S {@link CHANGE_OPS}, not a second three-literal tuple (POD-1251).
 * The model builds the full vocabulary by EXTENDING the global ops, so this
 * port and the kernel cannot drift on membership.
 */
export const SCOPED_CHANGE_OPS = CHANGE_OPS
export type ScopedChangeOp = (typeof SCOPED_CHANGE_OPS)[number]
export const ScopedChangeOp = ChangeOpField

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
 *
 * COMPOSED through {@link changeRowArm} (POD-1251) — the same factory the v1/v2
 * wire arms use — so the field list is not a fourth restatement. The port still
 * spells the target `id` (pre-cutover); the kernel and v2 wire spell `entityId`.
 * `seq` is the model's ChangeSeqField, composed inside the arm factory.
 */
export const ScopedChange = changeRowArm('id', z.string().min(1), ScopedChangeOp, z.unknown())
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
  epoch: FeedEpochField,
  /** Exclusive lower bound of the certified range. */
  fromSeq: z.number().int().nonnegative(),
  /** Inclusive upper bound — the batch stamp. */
  seq: z.number().int().nonnegative(),
  /**
   * ADR 2 D5's retention floor, REQUIRED on every certified frame — the same
   * decision, and for the same reason, as `DeltaFrame.minAvailableSeq` in
   * `@podium/sync`'s replica types (POD-306). Optional here would be read as
   * `?? 0` at every use site, and 0 is exactly the value meaning "nothing has
   * been pruned, your cursor is fine" — so an authority that forgot to publish
   * it would be indistinguishable from one whose log is complete, and D7 rung 2
   * would silently never fire.
   */
  minAvailableSeq: z.number().int().nonnegative(),
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
    // The LATER floor, not the earlier one and not the lower one. A merged frame
    // certifies through `second.seq`, so it must advertise retention as of that
    // point — carrying `first`'s floor would tell a replica the log still holds
    // ground that was pruned between the two frames, and rung 2 would not fire.
    minAvailableSeq: second.minAvailableSeq,
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
  epoch: FeedEpochField,
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
