/**
 * THE FEED IS SCOPED — the positive form of `publisher.unscoped.test.ts`
 * (POD-1077, landing POD-306's tripwire).
 *
 * ---------------------------------------------------------------------------
 * WHAT FLIPPED, ASSERTION BY ASSERTION
 * ---------------------------------------------------------------------------
 *
 * The deleted file made four claims and each has a replacement here, deliberately
 * in the same order, so a reviewer can diff intent rather than files:
 *
 *  1. *"every connection receives EVERY change, byte for byte"* — three
 *     connections standing for three principals. Now each receives its OWN slice,
 *     and — the half that matters more — each receives a WATERMARK over the range
 *     that was suppressed for it, so no principal is left with a hole.
 *  2. *"`connect()` takes an id and a position, nothing else; `publish()` takes
 *     only the batch"* — arity 2 and 1 were asserted so a scoped feed would be
 *     UNREPRESENTABLE. They are 3 and 2 now, and the arity is asserted again from
 *     the other side, because it is the shape of the seam and not an accident.
 *  3. *"the publisher holds NO visibility state to filter with"* — still true of
 *     the POLICY, and that is the design rather than a leftover: a connection
 *     holds a principal (it must, to know its audience) and this class holds no
 *     grant, owner or policy, because the decision is the Authority's (Amendment
 *     1 D12.7) and this side only frames it.
 *  4. *"the watermark frame POD-1077 will need already exists"* — it does, and it
 *     is now REACHED by suppression rather than by a method named after it.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THESE CASES ARE POINTED AT
 * ---------------------------------------------------------------------------
 *
 * Not "scoping does not work". The dangerous outcome is *scoping works and the
 * client silently never converges*: a suppressed row that nobody certifies is a
 * hole, the replica's `fromSeq === cursor` rule fails, it heals, the heal returns
 * the same filtered rows, forever (ADR 2 D2's named failure, POD-351's warning).
 * So every case below that suppresses something also asserts where the receiver's
 * position ENDS UP — a case that only checked "Bob did not get Ada's row" would
 * pass against exactly the broken implementation this issue exists to avoid.
 */

import { describe, expect, it } from 'vitest'
import type { ScopedChange } from '../authority/change-lifecycle'
import type { ScopedDelivery } from '../authority/scoping'
import type { DeltaFrame, ServerFrame } from '../replica/types'
import { FeedIdentityRegistry, type FeedIdentity, type FeedIdentityStore } from './identity'
import { FeedPublisher } from './publisher'
import type { FeedPrincipal } from './visibility'

const ULIDS = ['01JQ0P8Z3M4N5R6T7V8W9XAYBZ', '01JQ0P9Q1C2D3E4F5G6H7J8K9M']

function feed(maxBytes = 10_000): FeedPublisher {
  let held: FeedIdentity | null = null
  let index = 0
  const store: FeedIdentityStore = {
    readIdentity: () => held,
    writeIdentity: (identity) => {
      held = identity
    },
  }
  return new FeedPublisher({
    identity: new FeedIdentityRegistry(store, () => ULIDS[index++] ?? 'overflow'),
    retention: { minAvailableSeq: () => 0 },
    sendQueue: { maxBytes, sizeOf: () => 1 },
  })
}

const ADA: FeedPrincipal = { kind: 'user', userId: 'ada' }
const GRACE: FeedPrincipal = { kind: 'user', userId: 'grace' }
const AGENT: FeedPrincipal = {
  kind: 'agent',
  sessionId: 'sess-1',
  onBehalfOf: 'ada',
  scope: { kind: 'entities', keys: new Set(['session:a']) },
}

const change = (seq: number, entityId: string): ScopedChange => ({
  seq,
  entity: 'session',
  entityId,
  op: 'upsert',
  value: { id: entityId },
})

const batch = (throughSeq: number, changes: readonly ScopedChange[]): ScopedDelivery => ({
  kind: 'batch',
  throughSeq,
  changes,
})

const deltas = (frames: readonly ServerFrame[]): readonly DeltaFrame[] =>
  frames.filter((f): f is DeltaFrame => f.kind === 'delta')

/** What one connection saw: the ids it received, and where its position ended. */
const seen = (frames: readonly ServerFrame[]) => ({
  ids: deltas(frames).flatMap((f) => f.changes.map((c) => c.entityId)),
  ranges: deltas(frames).map((f) => [f.fromSeq, f.seq] as const),
})

describe('three connections, three principals, three DIFFERENT slices', () => {
  it('each principal receives its own rows — and a WATERMARK over what was suppressed', () => {
    // The fixture the deleted tripwire used, with the outcome inverted. The
    // authority evaluated seqs 1..3 for each principal; each sees one row and has
    // the other two certified as "evaluated, nothing for you".
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)
    const grace = publisher.connect('grace-1', 0, GRACE)
    const agent = publisher.connect('agent-1', 0, AGENT)

    publisher.publish(ADA, batch(3, [change(1, 'a')]))
    publisher.publish(GRACE, batch(3, [change(2, 'b')]))
    publisher.publish(AGENT, batch(3, [change(3, 'c')]))

    expect(seen(ada.drain()).ids).toEqual(['a'])
    expect(seen(grace.drain()).ids).toEqual(['b'])
    expect(seen(agent.drain()).ids).toEqual(['c'])
  })

  it('a principal for whom EVERYTHING was suppressed still advances to the head', () => {
    // THE case this issue exists for. Ada sees nothing in (0, 5] and must still
    // end up at 5: her next frame will certify (5, …], her replica's
    // `fromSeq === cursor` holds, and there is no heal. An implementation that
    // filtered and then emitted nothing passes every "she did not see it"
    // assertion and fails this one.
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)

    publisher.publish(ADA, batch(5, []))
    const first = seen(ada.drain())
    expect(first.ids).toEqual([])
    expect(first.ranges).toEqual([[0, 5]])

    publisher.publish(ADA, batch(7, [change(7, 'later')]))
    const second = seen(ada.drain())
    expect(second.ids).toEqual(['later'])
    // Contiguous with the watermark, NOT with 0. This is the assertion that fails
    // if the watermark had left the position behind.
    expect(second.ranges).toEqual([[5, 7]])
  })

  it("one principal's delivery reaches NO other principal's connection", () => {
    // The refusing arm, and it depends on no environmental fact: two connections
    // exist in the same publisher and one publish names one of them.
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)
    const grace = publisher.connect('grace-1', 0, GRACE)

    publisher.publish(ADA, batch(4, [change(4, 'ada-private')]))

    expect(seen(ada.drain()).ids).toEqual(['ada-private'])
    // Grace gets nothing at all — not even an empty frame — because nothing was
    // evaluated FOR her yet. Her position is untouched, so the watermark she is
    // owed can still certify (0, …] when her own evaluation arrives.
    expect(grace.drain()).toEqual([])
  })

  it('two connections of the SAME principal both receive its slice', () => {
    // Two devices, one person. Scoping is per principal and not per socket, and a
    // publisher that keyed by connection id would drop the second device silently.
    const publisher = feed()
    const phone = publisher.connect('phone', 0, ADA)
    const laptop = publisher.connect('laptop', 0, ADA)

    publisher.publish(ADA, batch(2, [change(2, 'shared')]))

    expect(seen(phone.drain()).ids).toEqual(['shared'])
    expect(seen(laptop.drain()).ids).toEqual(['shared'])
  })
})

describe('the seam SHAPE — a scoped feed is representable, and a filter here is not', () => {
  it('connect() takes a principal and publish() takes an audience', () => {
    // Was 2 and 1, asserted so scoping would be unrepresentable. The arities are
    // the deliverable, so they are pinned from this side now.
    expect(FeedPublisher.prototype.connect.length).toBe(3)
    expect(FeedPublisher.prototype.publish.length).toBe(2)
  })

  it('the publisher holds a PRINCIPAL per connection and no policy to filter with', () => {
    const publisher = feed()
    publisher.connect('ada-1', 0, ADA)

    // It knows WHO each connection is for — that is what an audience is.
    const connection = publisher.connect('ada-2', 0, ADA)
    expect(connection.principal).toEqual(ADA)

    // And it holds nothing to DECIDE with. The evaluation is the Authority's
    // (Amendment 1 D12.7); a policy reachable from here would be a second
    // filtering site, and a second site is invisible to every golden fixture
    // because a restatement is byte-identical on the wire.
    const own = Object.getOwnPropertyNames(publisher).join(' ').toLowerCase()
    for (const forbidden of ['polic', 'grant', 'owner', 'visib', 'acl']) {
      expect(own).not.toContain(forbidden)
    }
  })

  it('there is NO caller-facing rescope: it is an arm of the delivery, not a method', () => {
    // A caller that could ask for a rescope on a principal's behalf is an oracle
    // for what that principal may see, and the frame it produced would be
    // indistinguishable from an honest one. So the only route is the `rescope`
    // arm that `authority/scoping.ts` chooses from the size of the DERIVED set.
    expect('rescope' in FeedPublisher.prototype).toBe(false)
    expect('rescopeTo' in FeedPublisher.prototype).toBe(false)
    expect(Object.getOwnPropertyNames(FeedPublisher.prototype)).not.toContain('publishWatermark')
  })
})

describe('watermarks are free — D13.2 coalescing and D13.4 no-demotion', () => {
  it('a RUN of watermarks collapses to ONE frame covering the whole range', () => {
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)

    publisher.publish(ADA, batch(2, []))
    publisher.publish(ADA, batch(5, []))
    publisher.publish(ADA, batch(9, []))

    // One frame, (0, 9] — range extension only, never a reorder and never a drop.
    expect(seen(ada.drain()).ranges).toEqual([[0, 9]])
  })

  it('a following frame with real changes ABSORBS the pending watermark', () => {
    // D13.2's concatenation clause: (0,4] with nothing and (4,6] with a row merge
    // into (0,6] with that row. The alternative — deliver the watermark and then
    // the frame — is also legal, so this case asserts the ORDER-SAFE outcome
    // rather than the frame count: whatever arrives must start at 0 and end at 6
    // with no hole between.
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)

    publisher.publish(ADA, batch(4, []))
    publisher.publish(ADA, batch(6, [change(6, 'visible')]))

    const frames = seen(ada.drain())
    expect(frames.ids).toEqual(['visible'])
    expect(frames.ranges[0]?.[0]).toBe(0)
    expect(frames.ranges[frames.ranges.length - 1]?.[1]).toBe(6)
    // Contiguity across whatever split was chosen: each range starts where the
    // previous ended. This is the property, and it survives a change of strategy.
    for (let i = 1; i < frames.ranges.length; i += 1) {
      expect(frames.ranges[i]?.[0]).toBe(frames.ranges[i - 1]?.[1])
    }
  })

  it('a SUPPRESSED FIREHOSE cannot demote a replica (D13.4)', () => {
    // A replica must never be forced to re-bootstrap because of activity it is not
    // allowed to observe. The bound here is ONE frame, so an implementation that
    // queued watermarks would demote on the second one.
    const publisher = feed(1)
    const ada = publisher.connect('ada-1', 0, ADA)

    for (let seq = 1; seq <= 500; seq += 1) publisher.publish(ADA, batch(seq, []))

    expect(ada.isDemoted()).toBe(false)
    expect(ada.queuedBytes()).toBe(0)
    expect(seen(ada.drain()).ranges).toEqual([[0, 500]])
  })

  it('but a VISIBLE firehose still demotes — the paired half', () => {
    // Without this, "watermarks do not demote" is equally consistent with a queue
    // that never demotes anyone, which would delete D9 by accident.
    const publisher = feed(1)
    const ada = publisher.connect('ada-1', 0, ADA)

    publisher.publish(ADA, batch(1, [change(1, 'a')]))
    publisher.publish(ADA, batch(2, [change(2, 'b')]))

    expect(ada.isDemoted()).toBe(true)
    expect(ada.drain().map((f) => f.kind)).toEqual(['resync-required'])
  })

  it('a watermark held across a demotion is DROPPED, not replayed after re-arm', () => {
    // It certifies a range against a position that no longer exists. Delivering it
    // after a re-bootstrap would hand the replica a lower bound below its new
    // cursor — a frame it must reject, arriving on the recovery path.
    const publisher = feed(1)
    const ada = publisher.connect('ada-1', 0, ADA)

    publisher.publish(ADA, batch(3, []))
    publisher.publish(ADA, batch(4, [change(4, 'a')]))
    publisher.publish(ADA, batch(5, [change(5, 'b')]))
    expect(ada.isDemoted()).toBe(true)
    ada.drain()

    ada.rearm(20)
    publisher.publish(ADA, batch(21, [change(21, 'after')]))
    expect(seen(ada.drain()).ranges).toEqual([[20, 21]])
  })
})

describe('rescope — D14.4, and it is NOT resync-required', () => {
  it('the rescope arm sends a `rescope` frame and invalidates the position', () => {
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)
    publisher.publish(ADA, batch(2, [change(2, 'a')]))
    ada.drain()

    publisher.publish(ADA, { kind: 'rescope', throughSeq: 3, reason: 'visibility-change:big' })

    const [frame] = ada.drain()
    // The KIND is the assertion. D14.4 requires the two to be distinguishable in
    // telemetry: `resync-required` means the authority shed load, `rescope` means
    // the principal's rights changed, and a re-bootstrap storm after a policy
    // change must not be misdiagnosed as backpressure.
    expect(frame?.kind).toBe('rescope')
    expect(frame && 'reason' in frame && frame.reason).toBe('visibility-change:big')
    expect(ada.isDemoted()).toBe(true)
  })

  it('a rescope for one principal leaves another principal untouched', () => {
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)
    const grace = publisher.connect('grace-1', 0, GRACE)

    publisher.publish(ADA, { kind: 'rescope', throughSeq: 1, reason: 'rights-changed' })

    expect(ada.isDemoted()).toBe(true)
    expect(grace.isDemoted()).toBe(false)
    expect(grace.drain()).toEqual([])
  })

  it('after a rescope the connection receives no deltas until it re-arms', () => {
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)
    publisher.publish(ADA, { kind: 'rescope', throughSeq: 1, reason: 'rights-changed' })
    ada.drain()

    publisher.publish(ADA, batch(4, [change(4, 'a')]))
    expect(ada.drain()).toEqual([])

    ada.rearm(4)
    publisher.publish(ADA, batch(6, [change(6, 'b')]))
    expect(seen(ada.drain()).ranges).toEqual([[4, 6]])
  })
})

describe('evict rides the ordinary frame (D14.1)', () => {
  it('an evict is delivered as a change with NO payload, beside ordinary rows', () => {
    const publisher = feed()
    const ada = publisher.connect('ada-1', 0, ADA)

    publisher.publish(
      ADA,
      batch(6, [
        change(5, 'still-mine'),
        { seq: 6, entity: 'session', entityId: 'unshared', op: 'evict' },
      ]),
    )

    const [frame] = deltas(ada.drain())
    expect(frame?.changes.map((c) => [c.entityId, c.op])).toEqual([
      ['still-mine', 'upsert'],
      ['unshared', 'evict'],
    ])
    // "gone from YOUR VIEW — it still exists" carries nothing to apply. A payload
    // here would let a replica install content for an entity it just lost.
    const evicted = frame?.changes.find((c) => c.op === 'evict')
    expect(evicted && 'payload' in evicted).toBe(false)
  })
})
