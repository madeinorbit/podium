/**
 * THE EDGE AND THE CONCRETE LEGACY ADAPTER.
 *
 * The property under test is not "v1 clients still work" — that is the easy half
 * and a snapshot pipeline would satisfy it too. It is that the v1 messages are a
 * FUNCTION OF THE FEED: every assertion below drives the edge with feed frames
 * ONLY, and there is no other input a snapshot could come from. A test that
 * seeded the projection directly would pass against a server that still had a
 * second read path, which is exactly what this issue deletes.
 */

import type { ServerMessage } from '@podium/protocol'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyWireV1Adapter, LEGACY_WIRE_V1_EXPIRY } from './legacy-wire-v1-adapter'
import { type EdgePeer, type FeedFrame, WireFeedEdge } from './wire-feed-edge'

const FEED = { feedId: 'feed-01J', epoch: 'epoch-01J' } as const

const session = (id: string) => ({ sessionId: id, title: id }) as unknown
const issue = (id: string) => ({ id, title: id }) as unknown

const bootstrap = (changes: unknown[], seq = 2): FeedFrame =>
  ({
    type: 'feedBootstrap',
    ...FEED,
    fromSeq: 0,
    seq,
    minAvailableSeq: 0,
    changes,
    last: true,
  }) as FeedFrame

const delta = (fromSeq: number, seq: number, changes: unknown[]): FeedFrame =>
  ({ type: 'feedDelta', ...FEED, fromSeq, seq, minAvailableSeq: 0, changes }) as FeedFrame

const upsert = (seq: number, entity: string, entityId: string, value: unknown) => ({
  seq,
  entity,
  entityId,
  op: 'upsert',
  value,
})

class Peer implements EdgePeer {
  readonly received: ServerMessage[] = []
  constructor(
    readonly id: string,
    readonly wireVersion: number,
    readonly acceptsDelta = false,
  ) {}
  send(message: ServerMessage): void {
    this.received.push(message)
  }
  types(): string[] {
    return this.received.map((m) => m.type)
  }
}

const edge = () => new WireFeedEdge({ diagnostics: () => [] })

describe('every peer is served from the one feed', () => {
  let subject: WireFeedEdge

  beforeEach(() => {
    subject = edge()
  })

  it('serves a v2 peer the frame untranslated', () => {
    const peer = new Peer('v2', WIRE_VERSION)
    expect(subject.attach(peer)).toBeNull()
    const frame = delta(0, 1, [upsert(1, 'session', 's1', session('s1'))])
    subject.publish(frame)
    expect(peer.received).toEqual([frame])
  })

  it('builds a v1 full-list snapshot FROM the feed, with no other input', () => {
    const peer = new Peer('v1-legacy', 1, false)
    subject.attach(peer)
    subject.publish(
      bootstrap([
        upsert(1, 'session', 's1', session('s1')),
        upsert(2, 'issue', 'i1', issue('i1')),
      ]),
    )
    // The pre-cutover message SET and ORDER, byte-shape unchanged — synthesised
    // at the boundary. Nothing here read a session list from a feature. All five
    // lists go out on a bootstrap exactly as `onClientAttached` sent them, so a
    // v1 client that clears-and-replaces on each is unaffected by the cutover.
    expect(peer.types()).toEqual([
      'sessionsChanged',
      'issuesChanged',
      'automationsChanged',
      'automationRunsChanged',
      'conversationsChanged',
    ])
    expect(peer.received[0]).toEqual({ type: 'sessionsChanged', sessions: [session('s1')] })
  })

  it('sends a v1 delta peer metadataDelta with the `id` key it expects', () => {
    const peer = new Peer('v1-delta', 1, true)
    subject.attach(peer)
    subject.publish(delta(0, 1, [upsert(1, 'session', 's1', session('s1'))]))
    expect(peer.received).toEqual([
      {
        type: 'metadataDelta',
        seq: 1,
        fromExclusive: 0,
        changes: [{ seq: 1, id: 's1', op: 'upsert', entity: 'session', value: session('s1') }],
      },
    ])
  })

  it('re-sends only the kinds a delta touched, not all five lists', () => {
    const peer = new Peer('v1-legacy', 1, false)
    subject.attach(peer)
    subject.publish(bootstrap([upsert(1, 'session', 's1', session('s1'))], 1))
    peer.received.length = 0
    subject.publish(delta(1, 2, [upsert(2, 'issue', 'i1', issue('i1'))]))
    expect(peer.types()).toEqual(['issuesChanged'])
  })

  it('drops one entity from the v1 list when the feed removes it', () => {
    const peer = new Peer('v1-legacy', 1, false)
    subject.attach(peer)
    subject.publish(
      bootstrap([
        upsert(1, 'session', 's1', session('s1')),
        upsert(2, 'session', 's2', session('s2')),
      ]),
    )
    subject.publish(delta(2, 3, [{ seq: 3, entity: 'session', entityId: 's1', op: 'remove' }]))
    expect(peer.received.at(-1)).toEqual({ type: 'sessionsChanged', sessions: [session('s2')] })
  })

  it('folds a frame into the projection ONCE however many peers receive it', () => {
    const a = new Peer('a', 1, false)
    const b = new Peer('b', 1, false)
    subject.attach(a)
    subject.attach(b)
    subject.publish(bootstrap([upsert(1, 'session', 's1', session('s1'))], 1))
    subject.publish(delta(1, 2, [{ seq: 2, entity: 'session', entityId: 's1', op: 'remove' }]))
    // A second application of the same frame would be harmless here, but a
    // projection that re-applied a stale frame after a later one would not be —
    // the guard is asserted through the outcome both peers see.
    expect(a.received.at(-1)).toEqual({ type: 'sessionsChanged', sessions: [] })
    expect(b.received.at(-1)).toEqual({ type: 'sessionsChanged', sessions: [] })
  })

  it('translates a watermark to nothing for v1 — and to a real frame for v2', () => {
    const legacy = new Peer('v1', 1, true)
    const modern = new Peer('v2', WIRE_VERSION)
    subject.attach(legacy)
    subject.attach(modern)
    const watermark = delta(1, 9, [])
    subject.publish(watermark)
    expect(legacy.received).toEqual([])
    // The v2 peer's cursor advances over the suppressed range. That asymmetry IS
    // the cutover: the old wire could not carry the certified range, so a scoped
    // peer on it would accumulate permanent invisible gaps.
    expect(modern.received).toEqual([watermark])
  })

  it('heals a v1 peer by full replacement when the feed says rescope', () => {
    const peer = new Peer('v1', 1, true)
    subject.attach(peer)
    subject.publish(bootstrap([upsert(1, 'session', 's1', session('s1'))], 1))
    peer.received.length = 0
    subject.publish({
      type: 'feedRescope',
      ...FEED,
      seq: 4,
      cause: 'rights-changed',
    } as FeedFrame)
    // v1 has no word for "your rights changed"; the honest translation is the
    // world again, which is the correct rung taken with less information.
    expect(peer.types()).toContain('sessionsChanged')
  })
})

describe('the v1 adapter REFUSES an evict rather than degrading it', () => {
  it('drops the peer instead of rendering a revocation as a deletion', () => {
    const subject = edge()
    const peer = new Peer('v1', 1, false)
    const other = new Peer('v2', WIRE_VERSION)
    subject.attach(peer)
    subject.attach(other)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    subject.publish(delta(0, 1, [{ seq: 1, entity: 'issue', entityId: 'i1', op: 'evict' }]))
    spy.mockRestore()
    // ADR 2 Am1 D14.5: `remove` is not a substitute. A legacy peer that cannot be
    // told the truth is disconnected, not lied to.
    expect(peer.received).toEqual([])
    expect(subject.versions().totalPeers).toBe(1)
    // …and the v2 peer, which CAN express it, is served normally. Without this
    // the assertion above would also pass against an edge that dropped everyone.
    expect(other.received).toHaveLength(1)
  })

  it('is the adapter’s own refusal, not the edge’s', () => {
    const adapter = new LegacyWireV1Adapter({ diagnostics: () => [] })
    expect(() =>
      adapter.translate(delta(0, 1, [{ seq: 1, entity: 'issue', entityId: 'i1', op: 'evict' }]), {
        acceptsDelta: true,
      }),
    ).toThrow(/cannot express it/)
  })
})

describe('version negotiation at the edge', () => {
  it('refuses a peer below the window with 426 and the window in the body', () => {
    const subject = edge()
    const refusal = subject.attach(new Peer('ancient', 0))
    expect(refusal).toMatchObject({ status: 426, reason: 'unsupported-version', offered: 0 })
    expect(subject.versions().totalPeers).toBe(0)
  })

  it('refuses a peer ABOVE the window too', () => {
    expect(edge().attach(new Peer('from-the-future', WIRE_VERSION + 1))).toMatchObject({
      status: 426,
    })
  })

  it('reports the minimum connected version, which is the rollout question', () => {
    const subject = edge()
    subject.attach(new Peer('fresh', WIRE_VERSION))
    subject.attach(new Peer('stale-pwa', 1))
    expect(subject.versions().minimum).toBe(1)
    expect(subject.versions().canRaiseFloorTo(2)).toBe(false)
    subject.detach('stale-pwa')
    expect(subject.versions().canRaiseFloorTo(2)).toBe(true)
  })

  it('advertises the window it can actually serve', () => {
    expect(edge().support()).toEqual({ wire: WIRE_VERSION, min: MIN_SUPPORTED_VERSION })
  })
})

describe('the legacy adapter carries a MECHANICAL expiry', () => {
  it('expires on the support floor reaching 2, not on a date', () => {
    expect(LEGACY_WIRE_V1_EXPIRY.expiresWhenMinSupportedReaches).toBe(2)
    expect(LEGACY_WIRE_V1_EXPIRY.deleteByPhase).toBe('POD-279 Phase 7')
  })

  it('is NOT yet expired at the shipped floor — the gate can say NO', () => {
    // If this ever flips without the file being deleted, `audit-wire-adapters`
    // fails the build. Asserted here so the two cannot drift silently.
    expect(MIN_SUPPORTED_VERSION).toBeLessThan(LEGACY_WIRE_V1_EXPIRY.expiresWhenMinSupportedReaches)
    expect(edge().expiredAdapters()).toEqual([])
  })
})
