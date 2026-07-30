/**
 * The bounded send queue and the D9 demotion.
 *
 * The property that matters here is a NEGATIVE one — "no frame is ever silently
 * dropped" — and a negative property is the shape this run has repeatedly found
 * to be untested-but-credited. So the queue is driven past its bound and then
 * asked what it holds, rather than being asked whether it reported an overflow:
 * a queue that reported the overflow AND kept half the frames would pass the
 * report assertion and fail the contents assertion, and only the second one
 * distinguishes "demoted" from "dropped some and carried on".
 */

import { describe, expect, it } from 'vitest'
import { BoundedSendQueue, type SendQueueConfig } from './send-queue'
import type { DeltaFrame } from '../replica/types'

const FEED = 'feed-1'
const EPOCH = 'epoch-a'

function frame(fromSeq: number, seq: number): DeltaFrame {
  return {
    kind: 'delta',
    feedId: FEED,
    epoch: EPOCH,
    fromSeq,
    seq,
    minAvailableSeq: 0,
    changes: [],
  }
}

/** Every frame costs 10. Exact arithmetic beats discovering what a fixture weighs. */
const config = (maxBytes: number): SendQueueConfig => ({ maxBytes, sizeOf: () => 10 })

describe('BoundedSendQueue — admission', () => {
  it('ADMITS up to and INCLUDING the bound', () => {
    const queue = new BoundedSendQueue(config(30))
    expect(queue.offer(frame(0, 1)).kind).toBe('queued')
    expect(queue.offer(frame(1, 2)).kind).toBe('queued')
    // The third brings the total to exactly 30. A bound you cannot reach is a
    // bound one lower, so this must be admitted — and if the comparison were
    // `>=` this is the only case that would catch it.
    expect(queue.offer(frame(2, 3)).kind).toBe('queued')
    expect(queue.queuedBytes()).toBe(30)
    expect(queue.isDemoted()).toBe(false)
  })

  it('DEMOTES on the frame that would exceed the bound', () => {
    const queue = new BoundedSendQueue(config(30))
    queue.offer(frame(0, 1))
    queue.offer(frame(1, 2))
    queue.offer(frame(2, 3))

    const admission = queue.offer(frame(3, 4))
    expect(admission.kind).toBe('demoted')
    if (admission.kind !== 'demoted') throw new Error('unreachable')
    expect(admission.frame).toEqual({
      kind: 'resync-required',
      feedId: FEED,
      epoch: EPOCH,
      reason: 'send-queue-overflow',
    })
  })
})

describe('BoundedSendQueue — what overflow does to the frames already held', () => {
  it('discards EVERYTHING, so no partial range is ever delivered', () => {
    // This is the assertion that separates "demoted" from "dropped one and
    // carried on". Keeping the head, or the tail, would leave the replica holding
    // a range it cannot tell is incomplete — a permanent lie rather than a lost
    // update, since its next cursor advance certifies data it never received.
    const queue = new BoundedSendQueue(config(20))
    queue.offer(frame(0, 1))
    queue.offer(frame(1, 2))
    queue.offer(frame(2, 3))

    expect(queue.queuedFrames()).toBe(0)
    expect(queue.queuedBytes()).toBe(0)
    expect(queue.drain()).toEqual([])
  })

  it('SUPPRESSES further deltas rather than re-reporting or re-accumulating', () => {
    const queue = new BoundedSendQueue(config(10))
    queue.offer(frame(0, 1))
    expect(queue.offer(frame(1, 2)).kind).toBe('demoted')

    // Told once. A second control frame would have the replica re-bootstrap twice
    // for one overflow; re-accumulating would defeat the bound entirely, which is
    // the failure the bound exists to prevent.
    expect(queue.offer(frame(2, 3)).kind).toBe('suppressed')
    expect(queue.offer(frame(3, 4)).kind).toBe('suppressed')
    expect(queue.queuedBytes()).toBe(0)
    expect(queue.overflowCount()).toBe(1)
  })
})

describe('BoundedSendQueue — drain and re-arm', () => {
  it('drains in ORDER and empties', () => {
    const queue = new BoundedSendQueue(config(100))
    queue.offer(frame(0, 1))
    queue.offer(frame(1, 2))
    expect(queue.drain().map((f) => (f.kind === 'delta' ? f.seq : null))).toEqual([1, 2])
    expect(queue.queuedFrames()).toBe(0)
  })

  it('accepts again only after an EXPLICIT rearm', () => {
    const queue = new BoundedSendQueue(config(10))
    queue.offer(frame(0, 1))
    queue.offer(frame(1, 2))
    expect(queue.isDemoted()).toBe(true)

    // Still refusing — the paired half. Without it, "rearm works" is equally
    // consistent with a queue that never demoted or one that re-armed itself on
    // the next offer, which would resume deltas onto a replica still walking its
    // bootstrap.
    expect(queue.offer(frame(2, 3)).kind).toBe('suppressed')

    queue.rearm()
    expect(queue.isDemoted()).toBe(false)
    expect(queue.offer(frame(3, 4)).kind).toBe('queued')
  })

  it('demoteNow reports once and then returns null', () => {
    const queue = new BoundedSendQueue(config(100))
    expect(queue.demoteNow(FEED, EPOCH, 'operator-reset')?.reason).toBe('operator-reset')
    expect(queue.demoteNow(FEED, EPOCH, 'operator-reset')).toBeNull()
  })
})
