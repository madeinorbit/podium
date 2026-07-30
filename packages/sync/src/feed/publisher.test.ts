/**
 * The feed publisher — the producing half of ADR 2 D1, D5, D9 and Amendment 1 D13.
 *
 * These cases exist because until this module landed, every one of those
 * properties was supplied by `../conformance/authority.ts` — a fixture written to
 * exercise the Replica. A conformance suite run against that fixture certifies
 * the fixture. So each case here drives the PRODUCER and asserts something a
 * fixture cannot fake on its behalf: that the floor is read live, that the
 * covered range is contiguous per connection, and that overflow stops the
 * connection's position from advancing.
 */

import { describe, expect, it } from 'vitest'
import type { SequencedChange } from '../authority/change-lifecycle'
import type { DeltaFrame, ServerFrame } from '../replica/types'
import { FeedIdentityRegistry, type FeedIdentityStore } from './identity'
import { FeedPublisher, type FeedRetentionPort } from './publisher'

const ULIDS = [
  '01JQ0P8Z3M4N5R6T7V8W9XAYBZ',
  '01JQ0P9Q1C2D3E4F5G6H7J8K9M',
  '01JQ0PB5X7Y8Z9A0B1C2D3E4F5',
  '01JQ0PC6Y8Z9A0B1C2D3E4F5G6',
]

function registry(): FeedIdentityRegistry {
  let held: Parameters<FeedIdentityStore['writeIdentity']>[0] | null = null
  let index = 0
  const store: FeedIdentityStore = {
    readIdentity: () => held,
    writeIdentity: (identity) => {
      held = identity
    },
  }
  return new FeedIdentityRegistry(store, () => {
    const value = ULIDS[index]
    if (value === undefined) throw new Error('mint exhausted')
    index += 1
    return value
  })
}

/** A mutable floor, so a case can PRUNE and see the published value follow. */
function retention(initial: number | null = 0): FeedRetentionPort & { floor: number | null } {
  return {
    floor: initial,
    minAvailableSeq() {
      return this.floor
    },
  }
}

function change(seq: number, entityId: string): SequencedChange {
  return { seq, entity: 'session', entityId, op: 'upsert', value: { id: entityId } }
}

function publisher(deps?: { retention?: FeedRetentionPort; maxBytes?: number }) {
  return new FeedPublisher({
    identity: registry(),
    retention: deps?.retention ?? retention(0),
    sendQueue: { maxBytes: deps?.maxBytes ?? 1_000, sizeOf: () => 10 },
  })
}

const deltas = (frames: readonly ServerFrame[]): readonly DeltaFrame[] =>
  frames.filter((f): f is DeltaFrame => f.kind === 'delta')

describe('covered range — contiguous and non-overlapping PER CONNECTION', () => {
  it('certifies (fromSeq, seq] from the connection position, not from the batch', () => {
    const feed = publisher()
    const connection = feed.connect('c1', 0)

    feed.publish([change(1, 'a'), change(2, 'b')])
    feed.publish([change(3, 'c')])

    const frames = deltas(connection.drain())
    expect(frames.map((f) => [f.fromSeq, f.seq])).toEqual([
      [0, 2],
      [2, 3],
    ])
  })

  it('certifies from the CONNECTION position even when the batch starts above it', () => {
    // THE BUG THIS PINS: deriving `fromSeq` from the batch's first seq. It reads
    // naturally and it is wrong, and the wrongness is invisible unless the batch
    // SKIPS a seq — which is routine, since a seq the authority evaluated and
    // deduped away produces no row.
    //
    // Here the connection sits at 2 and the next batch begins at 4. The true
    // certified range is (2, 5]: the authority evaluated 3 and found nothing. The
    // batch-derived spelling emits (3, 5] instead, so seq 3 is never certified by
    // anyone — an invisible permanent gap, because the replica's contiguity rule
    // sees `fromSeq === cursor` fail once, heals, and is handed the same hole
    // again. This is the exact failure ADR 2 warns POD-308 about.
    //
    // My first draft of this case published a CONTIGUOUS batch, where the two
    // spellings agree and the mutant survives it. Measured, not assumed: mutating
    // `fromSeq` to the batch-derived form left that version green.
    const feed = publisher()
    const connection = feed.connect('late', 2)
    feed.publish([change(4, 'd'), change(5, 'e')])

    expect(deltas(connection.drain()).map((f) => [f.fromSeq, f.seq])).toEqual([[2, 5]])
  })

  it('two connections at DIFFERENT positions each get their own lower bound', () => {
    const feed = publisher()
    const early = feed.connect('early', 0)
    feed.publish([change(1, 'a'), change(2, 'b')])
    const late = feed.connect('late', 2)
    feed.publish([change(3, 'c')])

    expect(deltas(early.drain()).map((f) => [f.fromSeq, f.seq])).toEqual([
      [0, 2],
      [2, 3],
    ])
    expect(deltas(late.drain()).map((f) => [f.fromSeq, f.seq])).toEqual([[2, 3]])
  })

  it('a batch straddling a connection position carries only the part above it', () => {
    const feed = publisher()
    const connection = feed.connect('c1', 2)
    feed.publish([change(1, 'a'), change(2, 'b'), change(3, 'c')])

    const [frame] = deltas(connection.drain())
    expect(frame?.fromSeq).toBe(2)
    expect(frame?.changes.map((c) => c.seq)).toEqual([3])
  })

  it('emits a WATERMARK — an empty frame over a NON-empty range (Amendment 1 D13)', () => {
    const feed = publisher()
    const connection = feed.connect('c1', 0)
    feed.publishWatermark(5)

    const [frame] = deltas(connection.drain())
    expect(frame?.changes).toEqual([])
    expect([frame?.fromSeq, frame?.seq]).toEqual([0, 5])
  })

  it('does NOT emit for a connection already at or past the range', () => {
    const feed = publisher()
    const connection = feed.connect('c1', 9)
    feed.publish([change(1, 'a')])
    expect(connection.drain()).toEqual([])
  })
})

describe('minAvailableSeq — D5 floor, read LIVE on every frame', () => {
  it('publishes the floor, and follows it when the log is pruned', () => {
    // The counterfactual: a publisher that cached the floor at construction — or
    // that published a constant 0 — passes an assertion on the first frame and
    // fails here. Without the second frame this case cannot tell the two apart,
    // and a cached floor advertises a range the log no longer holds.
    const floor = retention(0)
    const feed = publisher({ retention: floor })
    const connection = feed.connect('c1', 0)

    feed.publish([change(1, 'a')])
    floor.floor = 4
    feed.publish([change(5, 'b')])

    expect(deltas(connection.drain()).map((f) => f.minAvailableSeq)).toEqual([0, 4])
  })

  it('publishes 0 for an EMPTY log, which means "nothing pruned" and not "unset"', () => {
    const feed = publisher({ retention: retention(null) })
    const connection = feed.connect('c1', 0)
    feed.publish([change(1, 'a')])
    expect(deltas(connection.drain())[0]?.minAvailableSeq).toBe(0)
  })
})

describe('backpressure — D9 demotion, and what it does to the connection position', () => {
  it('emits resync-required and STOPS advancing the position', () => {
    // The position assertion is the load-bearing one. A publisher that demoted but
    // let `fromSeq` advance would, on the next re-arm, resume from a cursor
    // certifying frames that were discarded — the silent divergence D9 exists to
    // prevent, wearing the appearance of a working demotion.
    const feed = publisher({ maxBytes: 10 })
    const connection = feed.connect('c1', 0)

    feed.publish([change(1, 'a')])
    feed.publish([change(2, 'b')])

    // ONLY the control frame. The first frame was admitted and then discarded by
    // the overflow, and that is the behaviour rather than an accident: delivering
    // it alongside the demotion would hand the replica a range it is about to
    // throw away, and delivering it INSTEAD of the demotion is the silent drop.
    const frames = connection.drain()
    expect(frames.map((f) => f.kind)).toEqual(['resync-required'])
    expect(connection.isDemoted()).toBe(true)

    // Re-arm at the seq the replica actually re-bootstrapped to, and the next
    // frame is certified from THERE — not from 2, which the demoted frame claimed.
    connection.rearm(7)
    feed.publish([change(8, 'c')])
    expect(deltas(connection.drain()).map((f) => [f.fromSeq, f.seq])).toEqual([[7, 8]])
  })

  it('bounds ONE connection without touching its neighbour', () => {
    // ADR 2 D9's whole argument: "one slow phone on a train takes down everyone's
    // server" is the outcome being avoided, so a demotion that spread would be the
    // bug rather than the fix.
    const feed = new FeedPublisher({
      identity: registry(),
      retention: retention(0),
      // The slow connection is the one that drains; the bound is per connection,
      // so a healthy peer that drains keeps flowing while a silent one demotes.
      sendQueue: { maxBytes: 10, sizeOf: () => 10 },
    })
    const slow = feed.connect('slow', 0)
    const healthy = feed.connect('healthy', 0)

    feed.publish([change(1, 'a')])
    healthy.drain()
    feed.publish([change(2, 'b')])

    expect(slow.isDemoted()).toBe(true)
    expect(healthy.isDemoted()).toBe(false)
    expect(deltas(healthy.drain()).map((f) => f.seq)).toEqual([2])
  })

  it('bumpEpoch demotes every connection and publishes the NEW identity', () => {
    const feed = publisher()
    const one = feed.connect('one', 0)
    const two = feed.connect('two', 0)
    feed.publish([change(1, 'a')])
    const epochBefore = deltas(one.drain())[0]?.epoch
    two.drain()

    feed.bumpEpoch('restore')

    for (const connection of [one, two]) {
      const [control] = connection.drain()
      expect(control?.kind).toBe('resync-required')
      expect(control?.epoch).not.toBe(epochBefore)
      expect(connection.isDemoted()).toBe(true)
    }
  })
})

describe('provenance rides the envelope (ADR 2 D8)', () => {
  it('carries originId / causationId / mutationId, and omits them when absent', () => {
    const feed = publisher()
    const connection = feed.connect('c1', 0)
    feed.publish([
      { ...change(1, 'a'), causationId: 'cmd-1', mutationId: 'mut-1', originId: 'peer-1' },
      change(2, 'b'),
    ])

    const [withProvenance, without] = deltas(connection.drain())[0]?.changes ?? []
    expect(withProvenance).toMatchObject({
      causationId: 'cmd-1',
      mutationId: 'mut-1',
      originId: 'peer-1',
    })
    // Absent, not `undefined`-valued: a fabricated provenance would let a replica
    // retire an outbox entry this change did not confirm.
    expect(without && 'causationId' in without).toBe(false)
  })

  it('a remove carries NO payload and an upsert always does', () => {
    const feed = publisher()
    const connection = feed.connect('c1', 0)
    feed.publish([
      { seq: 1, entity: 'session', entityId: 'a', op: 'remove' },
      change(2, 'b'),
    ])

    const [removal, upsert] = deltas(connection.drain())[0]?.changes ?? []
    expect(removal && 'payload' in removal).toBe(false)
    expect(upsert?.payload).toEqual({ id: 'b' })
  })
})
