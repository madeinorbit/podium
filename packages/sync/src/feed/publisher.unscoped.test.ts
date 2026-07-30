/**
 * THE FEED IS UNSCOPED, AND THIS FILE SAYS SO OUT LOUD.
 *
 * The Replica-side counterpart to `../authority/authority.unscoped.test.ts`, and
 * it exists for the same reason: a green suite must not be readable as privacy
 * that does not exist. Every case here asserts an ABSENCE — that every connection
 * receives every change, and that a per-principal slice is not merely unbuilt but
 * UNREPRESENTABLE at this seam.
 *
 * WHY THE ABSENCE IS A TEST AND NOT A COMMENT. A comment saying "scoping is
 * POD-1077's" ages into a comment that is wrong, and nothing fails on the day it
 * becomes wrong. These assertions fail LOUDLY the day POD-1077 lands, which is
 * the point: the person adding the filter is forced to come here, read why the
 * watermark has to land with it, and delete these cases deliberately rather than
 * discovering months later that half the suite was vacuous.
 *
 * WHAT POD-1077 MUST NOT DO WHEN IT DELETES THEM. Amendment 1 D13 is explicit
 * that a filter WITHOUT a watermark is a protocol break, not an optimisation:
 * every suppressed row becomes an invisible permanent gap, because the replica's
 * contiguity rule (`fromSeq === cursor`) turns a silently missing seq into a heal
 * that can never converge. The publisher can already EMIT a watermark — an empty
 * `changes` over a non-empty covered range, asserted below — so the frame shape is
 * ready. What is missing is only the per-principal evaluation that would give it
 * the meaning "suppressed for you".
 *
 * THE ONE THING THAT IS ALREADY SAFE, so it is not re-litigated: the Replica
 * cannot construct a slice even if a future frame carried one. `check-boundaries`
 * rule 10 forbids `packages/sync/src/replica/` from importing anything outside
 * itself and from naming any visibility verb, so scoping cannot arrive by drift on
 * the consuming side — only by a deliberate change here, on the producing side.
 */

import { describe, expect, it } from 'vitest'
import type { SequencedChange } from '../authority/change-lifecycle'
import type { DeltaFrame } from '../replica/types'
import { FeedIdentityRegistry, type FeedIdentity, type FeedIdentityStore } from './identity'
import { FeedPublisher } from './publisher'

const ULIDS = ['01JQ0P8Z3M4N5R6T7V8W9XAYBZ', '01JQ0P9Q1C2D3E4F5G6H7J8K9M']

function feed(): FeedPublisher {
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
    sendQueue: { maxBytes: 10_000, sizeOf: () => 1 },
  })
}

const change = (seq: number, entityId: string): SequencedChange => ({
  seq,
  entity: 'session',
  entityId,
  op: 'upsert',
  value: { id: entityId },
})

describe('the feed is UNSCOPED — three connections, one slice', () => {
  it('every connection receives EVERY change, byte for byte', () => {
    // Three connections standing for three principals. Under POD-1077 this is
    // precisely the fixture that must stop passing: three principals with
    // different grants cannot all legitimately receive the same rows.
    const publisher = feed()
    const connections = ['alice', 'bob', 'agent'].map((id) => publisher.connect(id, 0))

    publisher.publish([change(1, 'a'), change(2, 'b'), change(3, 'c')])

    const received = connections.map((c) =>
      c
        .drain()
        .filter((f): f is DeltaFrame => f.kind === 'delta')
        .flatMap((f) => f.changes.map((ch) => ch.entityId)),
    )
    expect(received).toEqual([
      ['a', 'b', 'c'],
      ['a', 'b', 'c'],
      ['a', 'b', 'c'],
    ])
  })

  it('a scoped feed is UNREPRESENTABLE: connect() takes an id and a position, nothing else', () => {
    // Arity, asserted the way POD-305 asserted `subscribe()`'s. A principal or a
    // filter parameter cannot be added without this failing, so the absence is
    // structural rather than a matter of nobody having passed one yet.
    expect(FeedPublisher.prototype.connect.length).toBe(2)
    // And publishing takes only the batch — there is nowhere to name an audience.
    expect(FeedPublisher.prototype.publish.length).toBe(1)
  })

  it('the publisher holds NO visibility state to filter with', () => {
    // A weaker claim than the arity one and worth making anyway: even the
    // internals carry no grant, owner or principal, so a filter could not be
    // written here without first introducing the state to filter on.
    const publisher = feed()
    publisher.connect('alice', 0)
    const own = Object.getOwnPropertyNames(publisher).join(' ').toLowerCase()
    for (const forbidden of ['grant', 'owner', 'principal', 'visib', 'scope', 'acl']) {
      expect(own).not.toContain(forbidden)
    }
  })
})

describe('the watermark frame POD-1077 will need already exists', () => {
  it('an EMPTY changes list over a NON-EMPTY covered range is emittable today', () => {
    // So the wire shape is not what blocks scoping, and POD-1077 does not get to
    // treat the watermark as future work: it is the same frame on the same ordered
    // pipe, which is what keeps single-emitter ordering the correctness property.
    const publisher = feed()
    const connection = publisher.connect('alice', 0)
    publisher.publishWatermark(4)

    const [frame] = connection.drain().filter((f): f is DeltaFrame => f.kind === 'delta')
    expect(frame?.changes).toEqual([])
    expect(frame?.seq).toBeGreaterThan(frame?.fromSeq ?? 0)
  })

  it('a watermark still advances the connection position, so it is not a gap', () => {
    // Amendment 1 D13.4. If a watermark left the position behind, a scoped feed
    // would heal-loop on every suppressed row — the failure mode that makes
    // "filter without watermark" a protocol break rather than a missing feature.
    const publisher = feed()
    const connection = publisher.connect('alice', 0)
    publisher.publishWatermark(4)
    connection.drain()
    publisher.publish([change(5, 'e')])

    const [frame] = connection.drain().filter((f): f is DeltaFrame => f.kind === 'delta')
    expect(frame?.fromSeq).toBe(4)
  })
})
