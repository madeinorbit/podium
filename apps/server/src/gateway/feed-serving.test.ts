/**
 * THE SERVING PATH, END TO END (POD-1203).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THESE ASSERTIONS ABOUT THE PRODUCT AND NOT ABOUT A FIXTURE
 * ---------------------------------------------------------------------------
 *
 * Every case drives a REAL `FeedServing` over a REAL `Authority` and a real
 * SQLite change log, and the ONLY input is a ledger commit. There is no list
 * builder, no feature service and no snapshot source anywhere in the harness —
 * so a `sessionsChanged` that arrives at a peer can only have been folded out of
 * the feed. Before the cutover the same assertions would have passed against a
 * server that also had a second read path; here there is nothing else a message
 * could come from, which is the property the cutover is FOR.
 *
 * The refusing arms depend on facts this file sets directly: a wire version
 * outside the advertised window (there is no privileged peer that skips the
 * check), and a peer that never announced the delta capability.
 */

import type { ServerMessage } from '@podium/protocol'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { feedTestPlumbing } from './feed-test-plumbing'
import { FEED_BOOTSTRAP_CHUNK_ROWS } from './feed-serving'
import type { EdgePeer } from './wire-feed-edge'

class Peer implements EdgePeer {
  readonly received: ServerMessage[] = []
  readonly terminate = vi.fn()
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
  last(type: string): ServerMessage | undefined {
    return [...this.received].reverse().find((m) => m.type === type)
  }
}

/** One committed entity row. The ONLY way anything enters this harness. */
const commit = (
  plumbing: Awaited<ReturnType<typeof feedTestPlumbing>>,
  entity: 'session' | 'issue' | 'conversation' | 'automation' | 'automationRun',
  id: string,
  value: unknown,
) =>
  plumbing.ledger.commit({
    write: async () => {},
    changes: () => [{ entity, id, op: 'upsert', value }],
  })

/** Publish whatever the Authority has appended, exactly as the funnel does. */
async function publishPending(plumbing: Awaited<ReturnType<typeof feedTestPlumbing>>, fromSeq: number): Promise<number> {
  const delivery = await plumbing.authority.changesSince(fromSeq, DEVICE_GRADE_PRINCIPAL)
  if (delivery === null) throw new Error('the log could not serve from that cursor')
  await plumbing.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)
  return delivery.throughSeq
}

describe('durable visibility changes revalidate ephemeral subscribers', () => {
  it('notifies the same registry subscribers for rescope and evict deliveries', async () => {
    const changed: string[][] = []
    const notify = (ids: readonly { toString(): string }[]) =>
      changed.push(ids.map((id) => String(id)))

    const rescoped = await feedTestPlumbing({ onVisibilityChanged: notify })
    const rescopeBootstrap = vi.spyOn(rescoped.authority, 'bootstrap')
    const rescopePeer = new Peer('rescope-peer', WIRE_VERSION, true)
    rescoped.serving.attach(
      rescopePeer,
      DEVICE_GRADE_PRINCIPAL,
      rescoped.routingPrincipal(rescopePeer.id),
    )
    await rescoped.serving.admissionSettled()
    await rescoped.serving.publish(DEVICE_GRADE_PRINCIPAL, {
      kind: 'rescope',
      throughSeq: 1,
      reason: 'rights-changed',
    })
    const afterRescope = new Peer('after-rescope', WIRE_VERSION, true)
    rescoped.serving.attach(
      afterRescope,
      DEVICE_GRADE_PRINCIPAL,
      rescoped.routingPrincipal(afterRescope.id),
    )
    await rescoped.serving.admissionSettled()
    expect(rescopeBootstrap).toHaveBeenCalledTimes(2)

    const evicted = await feedTestPlumbing({ onVisibilityChanged: notify })
    const evictPeer = new Peer('evict-peer', WIRE_VERSION, true)
    evicted.serving.attach(
      evictPeer,
      DEVICE_GRADE_PRINCIPAL,
      evicted.routingPrincipal(evictPeer.id),
    )
    await evicted.serving.admissionSettled()
    await evicted.serving.publish(DEVICE_GRADE_PRINCIPAL, {
      kind: 'batch',
      throughSeq: 1,
      changes: [{ seq: 1, entity: 'session', entityId: 's1', op: 'evict' }],
    })

    expect(changed).toEqual([['rescope-peer'], ['evict-peer']])
  })
})

describe('a v1 peer is served the pre-cutover messages, folded out of the feed', () => {
  it('a snapshot peer gets the five lists, in the attach order it always had', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'session', 's1', { sessionId: 's1' })
    await commit(p, 'issue', 'i1', { id: 'i1' })
    await commit(p, 'conversation', 'c1', { id: 'c1' })
    await commit(p, 'automation', 'a1', { id: 'a1' })
    await commit(p, 'automationRun', 'r1', { id: 'r1' })

    const peer = new Peer('legacy', 1)
    expect(p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))).toBeNull()
    await p.serving.admissionSettled()

    // ORDER IS LOAD-BEARING: `onClientAttached` sent sessions → issues →
    // automations → runs → conversations, and a client that applies lists in
    // arrival order renders differently if that changes.
    expect(peer.types()).toEqual([
      'sessionsChanged',
      'issuesChanged',
      'automationsChanged',
      'automationRunsChanged',
      'conversationsChanged',
    ])
    const sessions = peer.received[0] as { sessions: { sessionId: string }[] }
    expect(sessions.sessions).toEqual([{ sessionId: 's1' }])
  })

  it('serves the LATEST value, not a replay of every write', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'issue', 'i1', { id: 'i1', title: 'first' })
    await commit(p, 'issue', 'i1', { id: 'i1', title: 'second' })

    const peer = new Peer('legacy', 1)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    const issues = peer.last('issuesChanged') as { issues: { title: string }[] }
    expect(issues.issues).toEqual([{ id: 'i1', title: 'second' }])
  })

  it('a REMOVED entity is absent from the world — not a tombstone in the list', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'issue', 'i1', { id: 'i1' })
    await commit(p, 'issue', 'i2', { id: 'i2' })
    await p.ledger.commit({
      write: async () => {},
      changes: () => [{ entity: 'issue', id: 'i1', op: 'remove' }],
    })

    const peer = new Peer('legacy', 1)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    const issues = peer.last('issuesChanged') as { issues: { id: string }[] }
    expect(issues.issues.map((i) => i.id)).toEqual(['i2'])
  })

  it('a delta-capable v1 peer resumes EXACTLY where its bootstrap stopped', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'session', 's1', { sessionId: 's1' })
    const peer = new Peer('modern-v1', 1, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    const bootstrapSeq = await p.authority.cursor()

    await commit(p, 'session', 's2', { sessionId: 's2' })
    await publishPending(p, bootstrapSeq)

    const delta = peer.last('metadataDelta') as {
      fromExclusive: number
      seq: number
      changes: { id: string }[]
    }
    // CONTIGUITY BY CONSTRUCTION: the first delta's lower bound is the seq the
    // world was read at. A gap here is the heal-forever failure — and it is a
    // gap this harness could produce, because the commit happens after the
    // attach with nothing synchronising them but the attach's own read.
    expect(delta.fromExclusive).toBe(bootstrapSeq)
    expect(delta.changes.map((c) => c.id)).toEqual(['s2'])
    // …and it did NOT get a second world.
    expect(peer.types().filter((t) => t === 'sessionsChanged')).toHaveLength(1)
  })
})

describe('the current wire is canonical — the same feed, two shapes', () => {
  it('a v2 peer receives the frame itself, untranslated', async () => {
    const p = await feedTestPlumbing()
    const modern = new Peer('v2', WIRE_VERSION, true)
    const legacy = new Peer('v1', 1, true)
    p.serving.attach(modern, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(modern.id))
    await p.serving.admissionSettled()
    p.serving.attach(legacy, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(legacy.id))
    await p.serving.admissionSettled()

    await commit(p, 'issue', 'i1', { id: 'i1' })
    await publishPending(p, 0)

    // ONE feed, TWO renderings of it. The v2 frame carries the certified range
    // and the retention floor; the v1 message is the same rows in the old shape.
    const frame = modern.last('feedDelta') as {
      feedId: string
      epoch: string
      fromSeq: number
      seq: number
      minAvailableSeq: number
      changes: { entityId: string }[]
    }
    expect(frame.changes.map((c) => c.entityId)).toEqual(['i1'])
    expect(frame.minAvailableSeq).toBe(1)
    expect(frame.feedId).toBe('id-1')
    const delta = legacy.last('metadataDelta') as { changes: { id: string }[] }
    // The KEY RENAME lives in the adapter and nowhere else: v2 spells it
    // `entityId`, v1 spelled it `id`.
    expect(delta.changes.map((c) => c.id)).toEqual(['i1'])
  })

  it('streams a large v2 bootstrap with one atomic snapshot cursor', async () => {
    const p = await feedTestPlumbing()
    for (let i = 0; i < FEED_BOOTSTRAP_CHUNK_ROWS + 1; i += 1) {
      await commit(p, 'session', `s${i}`, { sessionId: `s${i}` })
    }

    const peer = new Peer('v2-large', WIRE_VERSION, true)
    const legacy = new Peer('v1-large', 1, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    p.serving.attach(legacy, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(legacy.id))
    await p.serving.admissionSettled()

    const frames = peer.received.filter((message) => message.type === 'feedBootstrap') as {
      feedId: string
      epoch: string
      fromSeq: number
      seq: number
      minAvailableSeq: number
      changes: { entityId: string }[]
      last: boolean
    }[]
    expect(frames).toHaveLength(2)
    expect(frames[0]?.changes).toHaveLength(FEED_BOOTSTRAP_CHUNK_ROWS)
    expect(frames[1]?.changes).toHaveLength(1)
    expect(frames.map((frame) => frame.last)).toEqual([false, true])
    expect(new Set(frames.map((frame) => frame.feedId)).size).toBe(1)
    expect(new Set(frames.map((frame) => frame.epoch)).size).toBe(1)
    expect(new Set(frames.map((frame) => frame.fromSeq)).size).toBe(1)
    expect(new Set(frames.map((frame) => frame.seq)).size).toBe(1)
    expect(new Set(frames.map((frame) => frame.minAvailableSeq)).size).toBe(1)
    expect(frames.flatMap((frame) => frame.changes).map((change) => change.entityId)).toEqual(
      Array.from({ length: FEED_BOOTSTRAP_CHUNK_ROWS + 1 }, (_, i) => `s${i}`),
    )

    // The v1 adapter has no partial-install wire shape. Its compatibility arm
    // still emits one complete legacy list while v2 takes the chunked path.
    const legacySessions = legacy.received.filter(
      (message) => message.type === 'sessionsChanged',
    )
    expect(legacySessions).toHaveLength(1)
    expect(legacySessions[0]?.type === 'sessionsChanged' && legacySessions[0].sessions).toHaveLength(
      FEED_BOOTSTRAP_CHUNK_ROWS + 1,
    )
  })

  it('a peer outside the supported window is REFUSED, and served nothing', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'issue', 'i1', { id: 'i1' })
    const ancient = new Peer('too-old', MIN_SUPPORTED_VERSION - 1)
    const future = new Peer('too-new', WIRE_VERSION + 1)

    const oldRefusal = p.serving.attach(
      ancient,
      DEVICE_GRADE_PRINCIPAL,
      p.routingPrincipal(ancient.id),
    )
    await p.serving.admissionSettled()
    const newRefusal = p.serving.attach(
      future,
      DEVICE_GRADE_PRINCIPAL,
      p.routingPrincipal(future.id),
    )
    await p.serving.admissionSettled()

    expect(oldRefusal?.status).toBe(426)
    expect(newRefusal?.status).toBe(426)
    // NOT SERVED IS THE POINT. A refused peer that still received frames would
    // be a peer parsing a wire it does not understand, which is worse than one
    // that is told to upgrade.
    expect(ancient.received).toEqual([])
    expect(future.received).toEqual([])
    await publishPending(p, 0)
    expect(ancient.received).toEqual([])
    expect(future.received).toEqual([])
    expect(p.serving.connectionCount()).toBe(0)
  })
  describe('bootstrap cadence across connections', () => {
    it('reuses and incrementally advances one principal world across reconnecting peers', async () => {
      const p = await feedTestPlumbing()
      await commit(p, 'session', 's1', { sessionId: 's1' })
      const bootstrap = vi.spyOn(p.authority, 'bootstrap')

      const first = new Peer('first', WIRE_VERSION, true)
      p.serving.attach(first, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(first.id))
      await p.serving.admissionSettled()
      expect(bootstrap).toHaveBeenCalledTimes(1)

      const sameHead = new Peer('same-head', WIRE_VERSION, true)
      p.serving.attach(sameHead, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(sameHead.id))
      await p.serving.admissionSettled()
      expect(bootstrap).toHaveBeenCalledTimes(1)

      // The Authority subscription advances the retained world synchronously,
      // before the queued delivery flush. A peer arriving in that window must see
      // the new row without forcing a second latest-state fold.
      await commit(p, 'session', 's2', { sessionId: 's2' })
      const advanced = new Peer('advanced', WIRE_VERSION, true)
      p.serving.attach(advanced, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(advanced.id))
      await p.serving.admissionSettled()
      expect(bootstrap).toHaveBeenCalledTimes(1)
      const advancedWorld = advanced.last('feedBootstrap') as {
        seq: number
        changes: { entityId: string }[]
      }
      expect(advancedWorld.seq).toBe(await p.authority.cursor())
      expect(advancedWorld.changes.map((change) => change.entityId)).toEqual(['s1', 's2'])

      await p.ledger.commit({
        write: async () => {},
        changes: () => [{ entity: 'session', id: 's1', op: 'remove' }],
      })
      const afterRemove = new Peer('after-remove', WIRE_VERSION, true)
      p.serving.attach(afterRemove, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(afterRemove.id))
      await p.serving.admissionSettled()
      const removedWorld = afterRemove.last('feedBootstrap') as {
        changes: { entityId: string }[]
      }
      expect(removedWorld.changes.map((change) => change.entityId)).toEqual(['s2'])
      expect(bootstrap).toHaveBeenCalledTimes(1)

      // A reconnect gap with no writes still reuses the last authoritative world.
      p.serving.detach(first.id)
      p.serving.detach(sameHead.id)
      p.serving.detach(advanced.id)
      p.serving.detach(afterRemove.id)
      const reconnected = new Peer('reconnected', WIRE_VERSION, true)
      p.serving.attach(reconnected, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(reconnected.id))
      await p.serving.admissionSettled()
      expect(bootstrap).toHaveBeenCalledTimes(1)
      expect(reconnected.types()).toContain('feedBootstrap')

      // Once no subscriber is present, a head movement cannot be reconstructed
      // from missed deliveries. The next peer falls back to one authoritative
      // fold rather than serving the retained world as if it were current.
      p.serving.detach(reconnected.id)
      await commit(p, 'session', 's3', { sessionId: 's3' })
      const afterGap = new Peer('after-gap', WIRE_VERSION, true)
      p.serving.attach(afterGap, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(afterGap.id))
      await p.serving.admissionSettled()
      expect(bootstrap).toHaveBeenCalledTimes(2)
      const afterGapWorld = afterGap.last('feedBootstrap') as { changes: { entityId: string }[] }
      expect(afterGapWorld.changes.map((change) => change.entityId)).toEqual(['s2', 's3'])
    })

    it.each(['before', 'after'] as const)(
      'rebuilds an advanced world when authorization changes %s delivery',
      async (timing) => {
        let revision = 0
        const p = await feedTestPlumbing({ authorizationRevision: () => revision })
        await commit(p, 'session', 's1', { sessionId: 's1' })
        const bootstrap = vi.spyOn(p.authority, 'bootstrap')
        const first = new Peer('first', WIRE_VERSION, true)
        p.serving.attach(first, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(first.id))
        await p.serving.admissionSettled()
        expect(bootstrap).toHaveBeenCalledTimes(1)

        // A delivery must neither poison an unchanged revision nor bless a new
        // revision for rows it did not rescope. Keep the subscription active so
        // the cache reaches the head and only the revision can reject reuse.
        if (timing === 'before') revision += 1
        await commit(p, 'session', 's2', { sessionId: 's2' })
        if (timing === 'after') revision += 1
        const reconnected = new Peer('reconnected', WIRE_VERSION, true)
        p.serving.attach(reconnected, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(reconnected.id))
        await p.serving.admissionSettled()
        expect(bootstrap).toHaveBeenCalledTimes(2)
        expect(reconnected.last('feedBootstrap')).toMatchObject({
          seq: await p.authority.cursor(),
          changes: [{ entityId: 's1' }, { entityId: 's2' }],
        })

        const sameRevision = new Peer('same-revision', WIRE_VERSION, true)
        p.serving.attach(sameRevision, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(sameRevision.id))
        await p.serving.admissionSettled()
        expect(bootstrap).toHaveBeenCalledTimes(2)
      },
    )

    it('the existing-peer guard sends no second world for a repeated attach', async () => {
      const p = await feedTestPlumbing()
      await commit(p, 'session', 's1', { sessionId: 's1' })
      const bootstrap = vi.spyOn(p.authority, 'bootstrap')
      const peer = new Peer('stable', WIRE_VERSION, true)

      p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
      await p.serving.admissionSettled()
      const received = peer.received.length
      p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
      await p.serving.admissionSettled()

      expect(peer.received).toHaveLength(received)
      expect(bootstrap).toHaveBeenCalledTimes(1)
    })
  })

  it('reports the window and the connected versions', async () => {
    const p = await feedTestPlumbing()
    p.serving.attach(new Peer('a', 1), DEVICE_GRADE_PRINCIPAL, p.routingPrincipal('a'))
    await p.serving.admissionSettled()
    p.serving.attach(new Peer('b', WIRE_VERSION), DEVICE_GRADE_PRINCIPAL, p.routingPrincipal('b'))
    await p.serving.admissionSettled()
    expect(p.serving.support()).toEqual({ wire: WIRE_VERSION, min: MIN_SUPPORTED_VERSION })
    // The rollout's "may I raise the floor" question, answerable.
    expect(p.serving.versions().minimum).toBe(1)
    expect(p.serving.expiredAdapters()).toEqual([])
  })
})

describe('a reconnect storm heals through the feed, with no snapshot path', () => {
  it('every reconnecting peer is served a world at its own position and resumes contiguously', async () => {
    // THE SHAPE OF THE INCIDENT: a deploy drops every socket, they all come back
    // at once, and writes keep landing while they do. Before the cutover a
    // reconnect was served by five features each rebuilding a full list; the
    // property that has to survive is that each peer's stream is contiguous from
    // ITS OWN bootstrap, not from a shared cursor.
    const p = await feedTestPlumbing()
    for (let i = 0; i < 20; i++) await commit(p, 'session', `s${i}`, { sessionId: `s${i}` })

    const peers = Array.from({ length: 12 }, (_, i) => new Peer(`c${i}`, 1, true))
    let published = 0
    const bootstrapSeq = new Map<string, number>()
    for (const [index, peer] of peers.entries()) {
      // Interleaved, which is what a storm is: a write lands between attaches, so
      // no two peers bootstrap at the same seq.
      if (index % 3 === 0) {
        await commit(p, 'session', `storm-`, { sessionId: `storm-${index}` })
        published = await publishPending(p, published)
      }
      expect(
        await p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id)),
      ).toBeNull()
      await p.serving.admissionSettled()
      bootstrapSeq.set(peer.id, await p.authority.cursor())
    }
    expect(new Set(bootstrapSeq.values()).size).toBeGreaterThan(1)

    await commit(p, 'session', 'after-the-storm', { sessionId: 'after-the-storm' })
    published = await publishPending(p, published)

    for (const peer of peers) {
      // 1. Each got a world, ONCE.
      expect(peer.types().filter((t) => t === 'sessionsChanged')).toHaveLength(1)
      const world = peer.received[0] as { sessions: { sessionId: string }[] }
      // 2. …and it is a world, not an empty stub: everything committed before
      //    that peer attached is in it.
      expect(world.sessions.length).toBeGreaterThanOrEqual(20)
      // 3. THE CHAIN: every delta it received is contiguous with the one before
      //    it, and the chain starts at the seq its own world was read at. This
      //    is the assertion the storm exists for — a shared cursor, or a world
      //    read at a different point from where framing began, shows up here as
      //    a gap, and a gap is the heal-forever failure.
      const deltas = peer.received.filter((m) => m.type === 'metadataDelta') as {
        fromExclusive: number
        seq: number
        changes: { id: string }[]
      }[]
      expect(deltas.length).toBeGreaterThan(0)
      let position = bootstrapSeq.get(peer.id) as number
      for (const delta of deltas) {
        expect(delta.fromExclusive).toBe(position)
        position = delta.seq
      }
      // 4. …and the last row committed reached it.
      expect(deltas.at(-1)?.changes.map((c) => c.id)).toContain('after-the-storm')
      // 5. No row it already had in its world was re-sent as a delta.
      const worldIds = new Set(world.sessions.map((s) => s.sessionId))
      expect(deltas.flatMap((d) => d.changes).some((c) => worldIds.has(c.id))).toBe(false)
    }
  })

  it('a peer that detaches stops being framed for — the storm does not grow the publisher', async () => {
    const p = await feedTestPlumbing()
    const peers = Array.from({ length: 5 }, (_, i) => new Peer(`c${i}`, 1, true))
    for (const peer of peers)
      p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
      await p.serving.admissionSettled()
    expect(p.serving.connectionCount()).toBe(5)
    for (const peer of peers) p.serving.detach(peer.id)
    expect(p.serving.connectionCount()).toBe(0)

    const before = peers.map((peer) => peer.received.length)
    await commit(p, 'session', 's1', { sessionId: 's1' })
    await publishPending(p, 0)
    expect(peers.map((peer) => peer.received.length)).toEqual(before)
  })
})

describe('advisories that are not feed content', () => {
  it('an advisory waits for an entity flush already framing asynchronously', async () => {
    const p = await feedTestPlumbing()
    const legacy = new Peer('ordered-v1', 1, true)
    p.serving.attach(legacy, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(legacy.id))
    await p.serving.admissionSettled()
    legacy.received.length = 0
    let release!: () => void
    const parked = new Promise<void>((resolve) => { release = resolve })
    const publish = p.serving.publish.bind(p.serving)
    let started = false
    vi.spyOn(p.serving, 'publish').mockImplementation(async (principal, delivery) => {
      started = true
      await parked
      await publish(principal, delivery)
    })
    await commit(p, 'conversation', 'ordered-conversation', { id: 'ordered-conversation' })
    const flushing = p.serving.flushPending()
    await vi.waitFor(() => expect(started).toBe(true))
    p.serving.publishAdvisory('conversation-diagnostics')
    // Let the advisory's scheduled turn run while the real entity frame is held.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(legacy.received).toEqual([])
    release()
    await flushing
    await vi.waitFor(() => {
      expect(legacy.types()).toEqual(['metadataDelta', 'conversationsChanged'])
    })
    const lists = legacy.received.filter((message) => message.type === 'conversationsChanged')
    expect(lists.every((message) => message.conversations.some((row) => row.id === 'ordered-conversation'))).toBe(true)
  })

  it('a diagnostics change re-serves the conversation list to a v1 peer, and nothing to a v2 one', async () => {
    let diagnostics = [{ kind: 'scan-error', detail: 'x' }] as never[]
    const p = await feedTestPlumbing({ diagnostics: () => diagnostics })
    await commit(p, 'conversation', 'c1', { id: 'c1' })
    const legacy = new Peer('v1', 1, true)
    const modern = new Peer('v2', WIRE_VERSION, true)
    p.serving.attach(legacy, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(legacy.id))
    await p.serving.admissionSettled()
    p.serving.attach(modern, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(modern.id))
    await p.serving.admissionSettled()
    const legacyBefore = legacy.received.length
    const modernBefore = modern.received.length

    diagnostics = [{ kind: 'scan-error', detail: 'y' }] as never[]
    p.serving.publishAdvisory('conversation-diagnostics')
    await vi.waitFor(() => expect(legacy.received.length).toBeGreaterThan(legacyBefore))

    const served = legacy.received.slice(legacyBefore) as {
      type: string
      diagnostics: { detail: string }[]
    }[]
    expect(served.map((m) => m.type)).toEqual(['conversationsChanged'])
    expect(served[0]?.diagnostics).toEqual([{ kind: 'scan-error', detail: 'y' }])
    // v2 does not carry them at all — the advisory is v1 debt and reaches no
    // current-wire peer, which is the resting state this mechanism should have.
    expect(modern.received.length).toBe(modernBefore)
  })
})

/**
 * THE DEFERRED ADMISSION'S CONTRACT (POD-3523).
 *
 * `attach` and `renegotiate` are synchronous because their production callers are
 * — Bun's `websocket.open` and `websocket.message`, which cannot yield (rule 51
 * case 2; the caller census is `docs/internal/pod-3523-attach-caller-census.md`).
 * So the admission is deferred, and these are the three promises that deferral
 * makes. Each one was FALSE on the integration tip, where the promise was simply
 * dropped, and each failure below was measured there before the fix was written.
 */
describe('an admission is deferred, and the deferral is a contract', () => {
  it('serves ONE world to a hello that arrives inside the attach admission', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'session', 's1', { sessionId: 's1' })
    const peer = new Peer('double', WIRE_VERSION, true)

    // Both in one tick, which is what a browser does: connect, then `hello` on
    // the very next frame. The admission started by the first has not installed a
    // position yet, so a guard that consults only `connections` says "not admitted"
    // and admits again — measured on the tip as two `feedBootstrap` frames.
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()

    expect(peer.types().filter((type) => type === 'feedBootstrap')).toHaveLength(1)
    expect(p.serving.connectionCount()).toBe(1)
  })

  it('abandons a peer that detaches inside its admission — no frames, no position', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'session', 's1', { sessionId: 's1' })
    const peer = new Peer('gone', WIRE_VERSION, true)

    // The socket closes while the world is still being read. On the tip the
    // admission carried on regardless: the peer was sent its whole world and a
    // `FeedConnection` was installed for it, so the publisher went on framing for
    // a socket nothing could deliver to.
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    p.serving.detach(peer.id)
    await p.serving.admissionSettled()

    expect(peer.received).toEqual([])
    expect(p.serving.connectionCount()).toBe(0)
  })

  it.each(['attach', 'renegotiate'] as const)('terminates a failed world read from %s', async (entry) => {
    const p = await feedTestPlumbing()
    await commit(p, 'session', 's1', { sessionId: 's1' })
    vi.spyOn(p.authority, 'bootstrap').mockRejectedValue(new Error('PROBE: the world read failed'))
    const peer = new Peer('doomed', WIRE_VERSION, true)

    expect(p.serving[entry](peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))).toBeNull()
    expect(peer.terminate).not.toHaveBeenCalled()
    // RESOLVES, does not reject: the rejection is caught and logged at the one
    // place the deferral is spelled. Before the fix it reached no `catch` at all,
    // because nothing held the promise — the client waited forever for a bootstrap
    // and the only trace was an unhandled rejection on a later tick.
    await expect(p.serving.admissionSettled()).resolves.toBeUndefined()

    expect(peer.terminate).toHaveBeenCalledOnce()
    expect(peer.received).toEqual([])
    expect(p.serving.connectionCount()).toBe(0)
  })
})


describe('failed admission ownership', () => {
  it('does not terminate a replacement peer when an abandoned read rejects', async () => {
    const p = await feedTestPlumbing()
    let rejectRead!: (error: Error) => void
    vi.spyOn(p.authority, 'bootstrap').mockImplementationOnce(() =>
      new Promise((_, reject) => { rejectRead = reject }),
    )
    const old = new Peer('reused', WIRE_VERSION, true)
    p.serving.attach(old, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(old.id))
    await vi.waitFor(() => expect(rejectRead).toBeTypeOf('function'))
    p.serving.detach(old.id)
    const replacement = new Peer(old.id, WIRE_VERSION, true)
    p.serving.attach(replacement, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(replacement.id))
    rejectRead(new Error('abandoned read failed'))
    await p.serving.admissionSettled()
    expect(old.terminate).not.toHaveBeenCalled()
    expect(replacement.terminate).not.toHaveBeenCalled()
    expect(replacement.types()).toContain('feedBootstrap')
    expect(p.serving.connectionCount()).toBe(1)
  })

  it('owns a termination exception and releases the admission slot', async () => {
    const p = await feedTestPlumbing()
    vi.spyOn(p.authority, 'bootstrap').mockRejectedValueOnce(new Error('read failed'))
    const peer = new Peer('throwing', WIRE_VERSION, true)
    peer.terminate.mockImplementation(() => { throw new Error('transport failed') })
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await expect(p.serving.admissionSettled()).resolves.toBeUndefined()
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    expect(peer.types()).toContain('feedBootstrap')
    expect(p.serving.connectionCount()).toBe(1)
  })
})
