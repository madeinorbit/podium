import { CLIENT_WIRE_VERSION, MIN_CLIENT_WIRE_VERSION, type ServerMessage } from '@podium/protocol'
import type { FeedScopingGrade } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { type EdgePeer, type FeedFrame, WireFeedEdge } from './wire-feed-edge'

const FEED = { feedId: 'feed-01J', epoch: 'epoch-01J' } as const
const delta = (fromSeq: number, seq: number, changes: unknown[] = []): FeedFrame =>
  ({ type: 'feedDelta', ...FEED, fromSeq, seq, minAvailableSeq: 0, changes }) as FeedFrame

class Peer implements EdgePeer {
  readonly received: ServerMessage[] = []
  readonly acceptsDelta = true
  constructor(readonly id: string, readonly wireVersion: number) {}
  send(message: ServerMessage): void { this.received.push(message) }
}
const edge = (grade: FeedScopingGrade = 'device-unscoped') =>
  new WireFeedEdge({ visibilityGrade: () => grade })

describe('current issue feed support', () => {
  it.each(['device-unscoped', 'per-principal'] as const)(
    'serves the minimum supported client every normalized frame (%s)', (grade) => {
      const subject = edge(grade)
      const peer = new Peer('supported', MIN_CLIENT_WIRE_VERSION)
      expect(subject.attach(peer)).toBeNull()
      const frames: FeedFrame[] = [
        delta(0, 3, ['issueProjection', 'issueUserState', 'issueGitState'].map((entity, index) => ({
          seq: index + 1, entity, entityId: 'i1', op: 'upsert', value: { id: 'i1' },
        }))),
        delta(3, 8),
        delta(8, 9, [{ seq: 9, entity: 'issueProjection', entityId: 'i1', op: 'evict' }]),
        { type: 'feedRescope', ...FEED, seq: 10, cause: 'rights-changed' } as FeedFrame,
      ]
      for (const frame of frames) subject.publish(frame)
      expect(peer.received).toEqual(frames)
    },
  )

  it.each([0, 1, 2, 3])('refuses retired client version %i before sending any data', (version) => {
    const subject = edge('per-principal')
    const peer = new Peer('outdated', version)
    expect(subject.attach(peer)).toMatchObject({
      status: 426, reason: 'unsupported-version', offered: version,
      support: { wire: CLIENT_WIRE_VERSION, min: MIN_CLIENT_WIRE_VERSION },
    })
    subject.publish(delta(0, 1, [{ seq: 1, entity: 'issueProjection', entityId: 'i1', op: 'upsert', value: {} }]))
    subject.publishTo(peer, delta(1, 2))
    expect(peer.received).toEqual([])
    expect(subject.versions().totalPeers).toBe(0)
  })

  it('refuses future clients with the supported window', () => {
    expect(edge().attach(new Peer('future', CLIENT_WIRE_VERSION + 1))).toMatchObject({ status: 426 })
  })

  it('reports only admitted peers and detaches them', () => {
    const subject = edge()
    subject.attach(new Peer('current', CLIENT_WIRE_VERSION))
    subject.attach(new Peer('retired', MIN_CLIENT_WIRE_VERSION - 1))
    expect(subject.versions().minimum).toBe(CLIENT_WIRE_VERSION)
    expect(subject.versions().totalPeers).toBe(1)
    subject.detach('current')
    expect(subject.versions().totalPeers).toBe(0)
  })

  it('advertises exactly the supported window and has no expired adapters', () => {
    expect(edge().support()).toEqual({ wire: CLIENT_WIRE_VERSION, min: MIN_CLIENT_WIRE_VERSION })
    expect(edge().expiredAdapters()).toEqual([])
  })

  it('delivers a frame sequence without altering order or watermark frames', async () => {
    const subject = edge()
    const peer = new Peer('current', CLIENT_WIRE_VERSION)
    subject.attach(peer)
    const frames = [delta(0, 1), delta(1, 2)]
    await expect(subject.publishSequenceTo(peer, frames.values())).resolves.toEqual({ ok: true })
    expect(peer.received).toEqual(frames)
  })
})
