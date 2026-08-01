/**
 * THE v2 WIRE'S COMPOSITION AND ITS ONE NON-NEGOTIABLE PROPERTY.
 *
 * Two separate jobs in one file, both of which the golden fixtures are
 * structurally unable to do:
 *
 *  1. COMPOSITION BY OBJECT IDENTITY. A restated field schema is byte-identical
 *     on the wire, so `wire-golden.json` passes on a forked schema — POD-305
 *     measured exactly that, and this run has reproduced it three times. Only
 *     `toBe` against the shared INSTANCE sees the fork, and only PER ARM: pinning
 *     arm 0 passes while a sixth entity kind arrives by copy-paste.
 *
 *  2. THE WATERMARK CANNOT BE FORGOTTEN. The failure this cutover most risks is
 *     a filtered payload without a certified range — every suppressed row then
 *     becomes a permanent invisible gap that heal-loops forever. Here that is
 *     tested as a SCHEMA property (a frame without the range does not parse),
 *     not as a producer convention, because a convention is what fails.
 */

import {
  AutomationRunWire,
  AutomationWire,
  ChangeCursorSeqField,
  ChangeEntityIdField,
  ChangeSeqField,
  ConversationSummaryWire,
  IssueDepProjection,
  IssueProjection,
  IssueWire,
  RepoProjection,
  SessionMeta,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { FeedEpochField, ScopedChangeOp } from '../planes/scoped-feed'
import {
  FeedBootstrapMessage,
  FeedChange,
  FeedDeltaMessage,
  FeedDeltaMessageLenient,
  feedFrameAcceptsAt,
  isFeedWatermark,
  UnknownFeedChange,
  validateFeedFrame,
} from './feed'
import { MetadataChangeOp } from './sync'

type Arm = { shape: Record<string, unknown> }
const arms = FeedChange.options as unknown as Arm[]

/** Which model schema each arm's payload must BE. Exhaustive by construction:
 *  the test below fails if an arm exists that this map does not name, so a sixth
 *  entity kind cannot arrive unchecked. */
const PAYLOAD_OF_KIND: Record<string, z.ZodTypeAny> = {
  session: SessionMeta,
  issue: IssueWire,
  issueProjection: IssueProjection,
  issueDep: IssueDepProjection,
  repo: RepoProjection,
  conversation: ConversationSummaryWire,
  automation: AutomationWire,
  automationRun: AutomationRunWire,
}

const kindOf = (arm: Arm): string =>
  ((arm.shape.entity as { _def: { value: string } })._def as { value: string }).value

const innerOf = (optional: unknown): unknown =>
  (optional as { _def: { innerType: unknown } })._def.innerType

const delta = (over: Partial<z.input<typeof FeedDeltaMessage>> = {}) => ({
  type: 'feedDelta' as const,
  feedId: 'feed-01J',
  epoch: 'epoch-01J',
  fromSeq: 4,
  seq: 6,
  minAvailableSeq: 0,
  changes: [],
  ...over,
})

describe('the v2 change row composes the shared vocabulary', () => {
  it('has all eight entity arms, so the per-arm loops below are not vacuous', () => {
    // The counterfactual guard POD-305 named: if `.options` stopped resolving,
    // every loop here would iterate nothing and pass silently.
    expect(arms).toHaveLength(8)
    expect(arms.map(kindOf).sort()).toEqual(Object.keys(PAYLOAD_OF_KIND).sort())
  })

  it('takes `seq` from the shared field INSTANCE in every arm', () => {
    for (const arm of arms) expect(arm.shape.seq).toBe(ChangeSeqField)
  })

  it('takes the target id from the shared field INSTANCE in every arm', () => {
    for (const arm of arms) expect(arm.shape.entityId).toBe(ChangeEntityIdField)
  })

  it('takes the SCOPED op vocabulary from the port INSTANCE in every arm', () => {
    // Not `GlobalChangeOpField`. The v2 wire's whole reason to exist upstream of
    // the feed is that `evict` is expressible on it, and taking the port's
    // instance is what makes a later change to that vocabulary reach the wire.
    for (const arm of arms) expect(arm.shape.op).toBe(ScopedChangeOp)
  })

  it('takes each payload from the model INSTANCE in every arm', () => {
    for (const arm of arms) {
      expect(innerOf(arm.shape.value)).toBe(PAYLOAD_OF_KIND[kindOf(arm)])
    }
  })

  it('keeps the lenient catch-all on the same shared fields', () => {
    expect(UnknownFeedChange.shape.seq).toBe(ChangeSeqField)
    expect(UnknownFeedChange.shape.entityId).toBe(ChangeEntityIdField)
    expect(UnknownFeedChange.shape.op).toBe(ScopedChangeOp)
  })

  it('spells the target id `entityId`, and v1 still spells it `id`', () => {
    // The rename POD-308 owns. Asserted in BOTH directions so the day someone
    // "tidies" v1 to match, this fails instead of silently breaking every
    // un-rebuilt client — which is the failure `fields/change.ts` warns about.
    for (const arm of arms) {
      expect(Object.keys(arm.shape)).toContain('entityId')
      expect(Object.keys(arm.shape)).not.toContain('id')
    }
  })

  it('makes `evict` expressible, which the v1 wire could not', () => {
    const evicted = FeedChange.parse({
      seq: 5,
      entity: 'issue',
      entityId: 'iss_1',
      op: 'evict',
    })
    expect(evicted.op).toBe('evict')
    // The counterfactual: this is what the pre-cutover wire refused, and why the
    // shipped composition roots throw rather than degrade an evict to a remove.
    expect(MetadataChangeOp.safeParse('evict').success).toBe(false)
  })
})

describe('the certified range travels with the payload', () => {
  it('accepts a frame that certifies its range — the instrument can say YES', () => {
    expect(FeedDeltaMessage.safeParse(delta()).success).toBe(true)
    expect(
      FeedBootstrapMessage.safeParse({ ...delta(), type: 'feedBootstrap', last: true }).success,
    ).toBe(true)
  })

  it.each([
    'fromSeq',
    'seq',
    'minAvailableSeq',
    'feedId',
    'epoch',
  ])('refuses a delta frame with no %s', (field) => {
    const frame: Record<string, unknown> = delta()
    delete frame[field]
    expect(FeedDeltaMessage.safeParse(frame).success).toBe(false)
  })

  it.each([
    'fromSeq',
    'seq',
    'minAvailableSeq',
    'feedId',
    'epoch',
  ])('refuses a BOOTSTRAP frame with no %s', (field) => {
    const frame: Record<string, unknown> = { ...delta(), type: 'feedBootstrap', last: true }
    delete frame[field]
    expect(FeedBootstrapMessage.safeParse(frame).success).toBe(false)
  })

  it('declares the range fields ONCE — the same instances in every frame', () => {
    for (const field of ['feedId', 'epoch', 'fromSeq', 'seq', 'minAvailableSeq'] as const) {
      expect(FeedDeltaMessage.shape[field]).toBe(FeedBootstrapMessage.shape[field])
      expect(FeedDeltaMessageLenient.shape[field]).toBe(FeedDeltaMessage.shape[field])
    }
    expect(FeedDeltaMessage.shape.epoch).toBe(FeedEpochField)
    expect(FeedDeltaMessage.shape.seq).toBe(ChangeCursorSeqField)
  })

  it('carries an OPAQUE epoch, never a counter', () => {
    // ADR 2 D1, and the kernel's `assertOpaqueEpoch` refuses the same shape at
    // the minting boundary. A number epoch must not even parse.
    expect(FeedDeltaMessage.safeParse(delta({ epoch: 3 as never })).success).toBe(false)
    expect(FeedDeltaMessage.safeParse(delta({ epoch: '' })).success).toBe(false)
  })

  it('treats an empty change list over a real range as a watermark', () => {
    expect(isFeedWatermark(delta())).toBe(true)
    // An EMPTY range is not a watermark: it certifies nothing and moves nothing.
    expect(isFeedWatermark(delta({ fromSeq: 6, seq: 6 }))).toBe(false)
    expect(isFeedWatermark(delta({ changes: [row(5)] }))).toBe(false)
  })
})

const row = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  entity: 'issue' as const,
  entityId: 'iss_1',
  op: 'remove' as const,
  ...over,
})

describe('validateFeedFrame refuses the claims a shape cannot check', () => {
  it('passes an honest frame — the instrument can say YES', () => {
    expect(validateFeedFrame(delta({ changes: [row(5), row(6)] }))).toEqual([])
  })

  it('catches a row outside the certified range', () => {
    expect(validateFeedFrame(delta({ changes: [row(9)] }))).toContain('row-outside-range')
    expect(validateFeedFrame(delta({ changes: [row(4)] }))).toContain('row-outside-range')
  })

  it('catches unordered rows', () => {
    expect(validateFeedFrame(delta({ changes: [row(6), row(5)] }))).toContain('rows-unordered')
  })

  it('catches an inverted range and an incoherent retention floor', () => {
    expect(validateFeedFrame(delta({ fromSeq: 9, seq: 4 }))).toContain('range-inverted')
    expect(validateFeedFrame(delta({ minAvailableSeq: 99 }))).toContain('floor-above-range')
  })

  it('catches the two ways a producer can confuse a deletion with a value', () => {
    expect(
      validateFeedFrame(delta({ changes: [row(5, { op: 'upsert', value: undefined })] })),
    ).toContain('upsert-without-value')
    expect(validateFeedFrame(delta({ changes: [row(5, { value: { id: 'x' } })] }))).toContain(
      'delete-with-value',
    )
  })

  it('refuses a bootstrap chunk that is not positive state', () => {
    // ADR 2 D5's safety proof: a snapshot lists what exists and is visible.
    // A `remove`/`evict` inside one is a producer streaming deltas as a snapshot.
    const bootstrap = { ...delta({ changes: [row(5)] }), last: true }
    expect(validateFeedFrame(bootstrap)).toContain('bootstrap-not-positive')
    // …and the same rows are fine in a DELTA, so this is not just "rejects rows".
    expect(validateFeedFrame(delta({ changes: [row(5)] }))).toEqual([])
  })
})

describe('the acceptance rule is the explicit lower bound', () => {
  const cursor = { feedId: 'feed-01J', epoch: 'epoch-01J', seq: 4 }

  it('accepts a frame that starts exactly where the replica stands', () => {
    expect(feedFrameAcceptsAt(cursor, delta())).toBe(true)
  })

  it('rejects a frame that starts past the cursor — the vanished-frame case', () => {
    // v1 could not see this: with no rows to inspect it had nothing to compare.
    expect(feedFrameAcceptsAt(cursor, delta({ fromSeq: 5 }))).toBe(false)
  })

  it('rejects a foreign feed or a rolled epoch', () => {
    expect(feedFrameAcceptsAt(cursor, delta({ feedId: 'other' }))).toBe(false)
    expect(feedFrameAcceptsAt(cursor, delta({ epoch: 'epoch-02K' }))).toBe(false)
  })
})
