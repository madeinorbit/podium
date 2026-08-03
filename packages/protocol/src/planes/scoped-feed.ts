import { CHANGE_OPS, ChangeOpField } from '@podium/model'
import { z } from 'zod'

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
 * THE CERTIFIED FRAME AND ITS WATERMARK ALGEBRA LIVE ON THE WIRE, NOT HERE
 * (POD-1196, deleting what POD-387 expressed and POD-308 declined).
 *
 * This module used to declare `ScopedChange`, `ScopedDeltaFrame`,
 * `isWatermarkFrame`, `acceptsAtCursor` and `coalesceCertifiedRanges`. All five
 * are gone, and the reason is not that they were unused — it is that
 * `../messages/feed.ts` considered this design and took a different one, in its
 * own words:
 *
 *   "A watermark is that frame with `changes: []`, which is why there is no
 *    watermark message type here: there is nothing separate to forget to send."
 *   "The certified-range fields, declared ONCE and spread into every frame."
 *
 * So the shipped frame is `FeedDeltaMessage` with `CertifiedRangeFields`, the
 * shipped watermark predicate is `isFeedWatermark`, and the shipped coalescing
 * is `FeedPublisher`'s per-connection `watermarkThrough` slot — which is the
 * stronger form, because its lower bound is always the connection's `fromSeq`
 * and a non-contiguous certified range is therefore unrepresentable rather than
 * merely rejected.
 *
 * `isWatermarkFrame` was not merely redundant, which is why relocating it was
 * not an option: it answered `changes.length === 0`, while `isFeedWatermark`
 * answers `changes.length === 0 && seq > fromSeq` and documents why — an EMPTY
 * range certifies nothing and moves no cursor, so it is not a watermark. The
 * deleted copy returned `true` for exactly that case.
 *
 * The replica acceptance rule `acceptsAtCursor` encoded is not lost either: it
 * is enforced at `@podium/sync`'s `replica.ts` and declared as rows `D7-1-GAP`
 * and the epoch-mismatch rung-4 row in `replica/transition-table.ts`, whose
 * totality test requires every declared row to be exercised by a real one.
 */

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
