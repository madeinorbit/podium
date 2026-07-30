/**
 * THE POST-CUTOVER ENTITY WIRE (POD-308, wire version 2).
 *
 * ---------------------------------------------------------------------------
 * WHY A NEW FRAME FAMILY RATHER THAN A WIDER `metadataDelta`
 * ---------------------------------------------------------------------------
 *
 * `metadataDelta` (v1, `./sync.ts`) carries `{ seq, changes, fromExclusive? }`.
 * Three of its properties make it unable to express the scoped feed, and the
 * third is the one that decides:
 *
 *  1. no feed identity — a bare integer cursor, which ADR 2 D1 calls meaningless;
 *  2. no retention floor, so D7 rung 2 cannot fire without a round trip;
 *  3. **the covered range is OPTIONAL** (`fromExclusive?`).
 *
 * (3) is the protocol break POD-351 named and POD-1077 repeated: a filtered
 * payload without a watermark leaves every suppressed row as a permanent
 * invisible gap that heal-loops forever. An optional field cannot be the
 * mechanism, because the failure mode IS someone omitting it — and the omission
 * is silent, well-formed, and byte-identical to a legitimate unfiltered frame.
 *
 * So on this wire the certified range is not a companion field, an accompanying
 * frame, or a capability. It is `fromSeq` + `seq` + `minAvailableSeq`, REQUIRED,
 * in the SAME object as `changes` — a frame that certifies nothing does not
 * parse. A watermark is that frame with `changes: []`, which is why there is no
 * watermark message type here: there is nothing separate to forget to send.
 *
 * ---------------------------------------------------------------------------
 * BOOTSTRAP IS A FEED FEATURE
 * ---------------------------------------------------------------------------
 *
 * `feedBootstrap` is the same change vocabulary at a definite `(feedId, epoch,
 * seq)`, chunked (ADR 2 D6 / Amendment 1 D15) — positive state only. It is NOT
 * the v1 full-list snapshot under a new name: it carries the cursor triple it
 * was read at, so the delta that follows it is contiguous BY CONSTRUCTION rather
 * than by the server sending the two close together. The v1 snapshot pipeline
 * this replaces had no cursor in the message at all, which is why it needed a
 * separate `sync.changesSince` round trip to become positionable.
 *
 * ---------------------------------------------------------------------------
 * THE ID KEY IS `entityId`, AND THAT RENAME IS THE ADAPTER'S JOB
 * ---------------------------------------------------------------------------
 *
 * The kernel spells the target `entityId`; the v1 wire spelled it `id`.
 * `packages/model/src/fields/change.ts` names POD-308 as the owner of
 * reconciling them and warns that shipping the rename from a field-schema
 * refactor is invisible until an un-rebuilt client drops every row. So v2 takes
 * the kernel's spelling — `ChangeTargetFields`, composed, not restated — and the
 * rename lives in exactly one place: the legacy v1 edge adapter, which expires.
 * The rename is deleted when the adapter is.
 */

import {
  AutomationRunWire,
  AutomationWire,
  ChangeCursorSeqField,
  ChangeEntityIdField,
  ChangeSeqField,
  ConversationSummaryWire,
  IssueWire,
  SessionMeta,
} from '@podium/model'
import { z } from 'zod'
import { FeedEpochField, ScopedChangeOp } from '../planes/scoped-feed'
import { changeRowArm } from './change-row'
import { MetadataEntityKind } from './sync'

/**
 * ONE arm of the v2 change union.
 *
 * Composed from the SHARED field instances — `ChangeSeqField`,
 * `ChangeEntityIdField` and `ScopedChangeOp` are the model's and the port's own
 * schemas, not copies. `feed.test.ts` asserts that per ARM rather than for arm
 * 0: POD-305 measured that a restated schema is byte-identical on the wire and
 * therefore passes every golden fixture, and that pinning the first arm passes
 * while a sixth kind arrives by copy-paste.
 *
 * `value` is present iff `op === 'upsert'` — a cross-field rule zod cannot
 * express inside a discriminated-union arm. It is NOT left to producers here
 * (that is how v1 stated it): {@link validateFeedDelta} enforces it on the frame,
 * where the range rules are enforced too.
 */
const feedChangeArm = <E extends z.ZodTypeAny, V extends z.ZodTypeAny>(entity: E, value: V) =>
  changeRowArm('entityId', entity, ScopedChangeOp, value)

export const FeedChange = z.discriminatedUnion('entity', [
  feedChangeArm(z.literal('session'), SessionMeta),
  feedChangeArm(z.literal('issue'), IssueWire),
  feedChangeArm(z.literal('conversation'), ConversationSummaryWire),
  feedChangeArm(z.literal('automation'), AutomationWire),
  feedChangeArm(z.literal('automationRun'), AutomationRunWire),
])
export type FeedChange = z.infer<typeof FeedChange>

/** The catch-all arm — a kind THIS build does not know, from a newer server.
 *  Known kinds are excluded, so a known-kind row with an invalid value still
 *  fails parse (quarantine → heal) instead of sneaking through untyped. Same
 *  forward-compat contract as v1's `UnknownMetadataChange`, same reason. */
export const UnknownFeedChange = feedChangeArm(
  z.string().refine((e) => !MetadataEntityKind.options.includes(e as never), {
    message: 'known entity kinds must parse through the strict FeedChange union',
  }),
  z.unknown(),
)
export type UnknownFeedChange = z.infer<typeof UnknownFeedChange>

export const FeedChangeLenient = z.union([FeedChange, UnknownFeedChange])
export type FeedChangeLenient = FeedChange | UnknownFeedChange

export function isKnownFeedChange(change: FeedChangeLenient): change is FeedChange {
  return MetadataEntityKind.options.includes(change.entity as never)
}

/**
 * The certified-range fields, declared ONCE and spread into every frame that
 * carries rows.
 *
 * A frame family where each member restated these would let one member drift to
 * `fromSeq?` in a refactor, and nothing downstream would notice until a
 * principal's suppressed rows went missing in production. Spreading one shape is
 * what makes "the watermark travels with the payload" a property of the type
 * rather than of five copies staying in agreement.
 */
export const CertifiedRangeFields = {
  feedId: z.string().min(1),
  epoch: FeedEpochField,
  /** Exclusive lower bound of the range this frame certifies. */
  fromSeq: ChangeCursorSeqField,
  /** Inclusive upper bound — the frame's stamp. */
  seq: ChangeCursorSeqField,
  /** ADR 2 D5's retention floor. Required; 0 means "nothing pruned". */
  minAvailableSeq: ChangeCursorSeqField,
} as const

/**
 * THE entity frame of wire v2.
 *
 *   "I have evaluated every global seq in `(fromSeq, seq]` against your
 *    principal, and `changes` contains exactly those you may see."
 *
 * `changes: []` over a non-empty range is a WATERMARK — the normal path under
 * private-by-default, and the reason there is no separate watermark type.
 */
export const FeedDeltaMessage = z.object({
  type: z.literal('feedDelta'),
  ...CertifiedRangeFields,
  changes: z.array(FeedChange),
})
export type FeedDeltaMessage = z.infer<typeof FeedDeltaMessage>

/** {@link FeedDeltaMessage} as CONSUMERS parse it (kind-tolerant). */
export const FeedDeltaMessageLenient = z.object({
  type: z.literal('feedDelta'),
  ...CertifiedRangeFields,
  changes: z.array(FeedChangeLenient),
})
export type FeedDeltaMessageLenient = z.infer<typeof FeedDeltaMessageLenient>

/**
 * One chunk of a bootstrap read at a definite `(feedId, epoch, seq)`.
 *
 * `fromSeq` is 0 on every chunk and is NOT dropped from the shape: a bootstrap
 * certifies `(0, seq]` — everything up to the snapshot point — which is the same
 * claim a delta makes, and spelling it the same way is what lets a replica hold
 * one acceptance rule instead of two.
 */
export const FeedBootstrapMessage = z.object({
  type: z.literal('feedBootstrap'),
  ...CertifiedRangeFields,
  /** Positive state only: `upsert` rows. A `remove`/`evict` here is malformed. */
  changes: z.array(FeedChange),
  /** False on every chunk but the last. A replica installs on `last`. */
  last: z.boolean(),
})
export type FeedBootstrapMessage = z.infer<typeof FeedBootstrapMessage>

export const FeedBootstrapMessageLenient = z.object({
  type: z.literal('feedBootstrap'),
  ...CertifiedRangeFields,
  changes: z.array(FeedChangeLenient),
  last: z.boolean(),
})
export type FeedBootstrapMessageLenient = z.infer<typeof FeedBootstrapMessageLenient>

/**
 * ADR 2 Amendment 1 D14.4 — "your rights changed; re-bootstrap scoped".
 *
 * A DISTINCT message type from {@link FeedResyncRequiredMessage} on purpose:
 * collapsing them makes an authz event look like a performance event, and a
 * re-bootstrap storm after a policy change would be misdiagnosed as backpressure.
 */
export const FeedRescopeMessage = z.object({
  type: z.literal('feedRescope'),
  feedId: z.string().min(1),
  epoch: FeedEpochField,
  /** The seq the rights change occupies in the global log (D14.3). */
  seq: ChangeCursorSeqField,
  cause: z.literal('rights-changed'),
  reason: z.string().optional(),
})
export type FeedRescopeMessage = z.infer<typeof FeedRescopeMessage>

/** ADR 2 D9 — the authority shed load. Also rung 2, different cause. */
export const FeedResyncRequiredMessage = z.object({
  type: z.literal('feedResyncRequired'),
  feedId: z.string().min(1),
  epoch: FeedEpochField,
  cause: z.literal('authority-shed-load'),
  reason: z.string().optional(),
})
export type FeedResyncRequiredMessage = z.infer<typeof FeedResyncRequiredMessage>

/** The cursor a reconnecting replica presents in `hello` so the server can pick
 *  a rung: resume with deltas, or re-bootstrap. Feed identity is part of it —
 *  a bare seq from a foreign feed or a rolled epoch is unresumable, and saying
 *  so needs all three fields. */
export const FeedCursorField = z.object({
  feedId: z.string().min(1),
  epoch: FeedEpochField,
  seq: ChangeCursorSeqField,
})
export type FeedCursorField = z.infer<typeof FeedCursorField>

export type FeedServerMessage =
  | FeedDeltaMessage
  | FeedBootstrapMessage
  | FeedRescopeMessage
  | FeedResyncRequiredMessage

export const FEED_MESSAGE_TYPES = [
  'feedDelta',
  'feedBootstrap',
  'feedRescope',
  'feedResyncRequired',
] as const

// ---------------------------------------------------------------------------
// Frame-level validation — the rules a shape cannot state
// ---------------------------------------------------------------------------

export type FeedFrameViolation =
  | 'range-inverted'
  | 'floor-above-range'
  | 'row-outside-range'
  | 'rows-unordered'
  | 'upsert-without-value'
  | 'delete-with-value'
  | 'bootstrap-not-positive'

/**
 * Validate a delta or bootstrap frame against the claim it makes.
 *
 * Every rule here is one a shape-only check would pass and a replica would then
 * act on:
 *
 *  - a row outside `(fromSeq, seq]` is a row the frame did not certify, so
 *    applying it advances a cursor over ground nobody evaluated;
 *  - unordered rows break the replica's single-pass apply;
 *  - an `upsert` with no value installs `undefined` as an entity;
 *  - a `remove`/`evict` WITH a value is a producer that thinks a deletion
 *    carries state — the ADR 2 D5 confusion this wire exists to prevent;
 *  - a bootstrap chunk carrying anything but `upsert` contradicts D5's safety
 *    proof that a snapshot is positive state.
 *
 * Returns the violations, empty when the frame is honest. Callers on the
 * PRODUCING side assert emptiness; consumers treat non-empty as rung 3
 * (malformed frame → re-bootstrap), never as "drop the bad rows".
 */
export function validateFeedFrame(frame: {
  fromSeq: number
  seq: number
  minAvailableSeq: number
  /** Derived from the arm shape, not restated: a second declaration of what a
   *  change row is would be invisible to every golden fixture. */
  changes: readonly Omit<UnknownFeedChange, 'entity' | 'entityId'>[]
  last?: boolean
}): FeedFrameViolation[] {
  const violations: FeedFrameViolation[] = []
  const isBootstrap = frame.last !== undefined
  if (frame.seq < frame.fromSeq) violations.push('range-inverted')
  // The floor may sit anywhere at or below the frame's stamp: a frame certifying
  // ground the log has since pruned below is exactly what tells a replica to
  // re-bootstrap. A floor ABOVE the stamp is incoherent — the authority claims to
  // have evaluated seqs it also claims not to retain.
  if (frame.minAvailableSeq > frame.seq && frame.seq !== 0) violations.push('floor-above-range')
  let previous = frame.fromSeq
  for (const change of frame.changes) {
    if (change.seq <= frame.fromSeq || change.seq > frame.seq) {
      if (!violations.includes('row-outside-range')) violations.push('row-outside-range')
    }
    if (change.seq <= previous && !violations.includes('rows-unordered')) {
      violations.push('rows-unordered')
    }
    previous = Math.max(previous, change.seq)
    if (change.op === 'upsert') {
      if (change.value === undefined && !violations.includes('upsert-without-value')) {
        violations.push('upsert-without-value')
      }
    } else {
      if (change.value !== undefined && !violations.includes('delete-with-value')) {
        violations.push('delete-with-value')
      }
      if (isBootstrap && !violations.includes('bootstrap-not-positive')) {
        violations.push('bootstrap-not-positive')
      }
    }
  }
  return violations
}

/** True when this frame certifies a range but shows no rows in it — the
 *  watermark case. An EMPTY range (`fromSeq === seq`) is not a watermark: it
 *  certifies nothing and moves no cursor. */
export function isFeedWatermark(frame: {
  fromSeq: number
  seq: number
  changes: readonly unknown[]
}): boolean {
  return frame.changes.length === 0 && frame.seq > frame.fromSeq
}

/**
 * The replica acceptance rule (ADR 2 Amendment 1 D13), stated once.
 *
 * Strictly stronger than v1's "the first change's seq must be cursor + 1": an
 * explicit lower bound also catches a frame that vanished between two accepted
 * ones, which the v1 rule could not see because a frame carrying no rows had
 * nothing to compare.
 */
export function feedFrameAcceptsAt(
  cursor: { feedId: string; epoch: string; seq: number },
  frame: { feedId: string; epoch: string; fromSeq: number },
): boolean {
  return (
    cursor.feedId === frame.feedId && cursor.epoch === frame.epoch && cursor.seq === frame.fromSeq
  )
}
