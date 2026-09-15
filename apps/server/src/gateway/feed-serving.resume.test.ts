/**
 * A RECONNECT THAT COSTS A FRAME, NOT A WORLD (POD-2061).
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ASSERT, AND WHY IT IS THE FRAMES AND NOT A FLAG
 * ---------------------------------------------------------------------------
 *
 * The finding this closes was measured on the wire: every admitted socket was
 * served the whole visible world, so a Wi-Fi flap on a client whose cache was
 * seconds old cost a full read and a full transfer. The fix is only real if the
 * frames stop arriving, so that is what every case here reads — what a peer
 * RECEIVED, from a real `FeedServing` over a real `Authority` and a real change
 * log. A test that asserted "resume was chosen" against an internal flag would
 * pass just as well against a server that then sent the world anyway.
 *
 * The refusing cases matter as much as the accepting one: a cursor honoured when
 * it should not be is a replica told it is caught up over a range nobody served,
 * which is the permanent invisible gap ADR 2 D5 exists to prevent. So each reason
 * a cursor can be refused — a foreign feed, a rolled epoch, a position past the
 * head, a position below the retained floor, a wire that cannot express the
 * answer — is exercised separately and must produce the world.
 */

import type { FeedCursorField, ServerMessage } from '@podium/protocol'
import { WIRE_VERSION } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { feedTestPlumbing } from './feed-test-plumbing'
import type { EdgePeer } from './wire-feed-edge'

class Peer implements EdgePeer {
  readonly received: ServerMessage[] = []
  constructor(
    readonly id: string,
    readonly wireVersion: number = WIRE_VERSION,
    readonly acceptsDelta = true,
    readonly syncHttp = false,
  ) {}
  send(message: ServerMessage): void {
    this.received.push(message)
  }
  types(): string[] {
    return this.received.map((m) => m.type)
  }
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[]
  }
}

const commit = (p: Awaited<ReturnType<typeof feedTestPlumbing>>, id: string) =>
  p.ledger.commit({
    write: async () => {},
    changes: () => [{ entity: 'session', id, op: 'upsert', value: { sessionId: id } }],
  })

/** A populated server, and a peer already admitted the ordinary way — the state
 *  every one of these cases reconnects INTO. */
async function servedOnce(opts: Parameters<typeof feedTestPlumbing>[0] = {}) {
  const p = await feedTestPlumbing(opts)
  await commit(p, 's1')
  await commit(p, 's2')
  const cold = new Peer('cold')
  p.serving.attach(cold, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(cold.id))
  await p.serving.admissionSettled()
  const identity = await p.serving.identity()
  const held: FeedCursorField = {
    feedId: identity.feedId,
    epoch: identity.epoch,
    seq: await p.authority.cursor(),
  }
  return { p, cold, held }
}

/** Reconnect a NEW peer presenting `cursor`. A reconnect is a new socket and
 *  therefore a new peer id; reusing the old one would take the idempotent
 *  re-attach path and prove nothing. */
async function reconnect(
  ctx: Awaited<ReturnType<typeof servedOnce>>,
  cursor: FeedCursorField | undefined,
  wireVersion: number = WIRE_VERSION,
): Promise<Peer> {
  const peer = new Peer(`resumed-${wireVersion}-${cursor?.seq ?? 'none'}`, wireVersion)
  ctx.p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id), cursor)
  // The admission is DEFERRED [POD-3523]: `renegotiate` is synchronous because its
  // production caller is, so an observer waits for it explicitly.
  await ctx.p.serving.admissionSettled()
  return peer
}

describe('a cursor the log can serve is answered with a resume, not a world', () => {
  it('sends one feedResume and not one row of the world', async () => {
    const ctx = await servedOnce()
    // The counterfactual, in the same test: the cold peer that was admitted
    // WITHOUT a cursor received the world, so "no bootstrap" below is a property
    // of the cursor and not of an empty server.
    expect(ctx.cold.types()).toEqual(['feedResume'])

    const peer = await reconnect(ctx, ctx.held)

    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.of('feedResume')[0]).toEqual({
      type: 'feedResume',
      feedId: ctx.held.feedId,
      epoch: ctx.held.epoch,
      seq: ctx.held.seq,
    })
  })

  it('frames the next delta from the position it granted', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, ctx.held)

    await commit(ctx.p, 's3')
    const delivery = await ctx.p.authority.changesSince(ctx.held.seq, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) throw new Error('the log could not serve from that cursor')
    await ctx.p.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)

    // CHAINS ONTO WHAT THE REPLICA HOLDS. `fromSeq === cursor.seq` is the exact
    // acceptance rule (ADR 2 Am1 D13), so this frame applies without a heal —
    // the socket alone carries the replica forward, and the HTTP catch-up is the
    // shortcut for `(cursor, head]` rather than the only route.
    const delta = peer.of('feedDelta')
    expect(delta).toHaveLength(1)
    expect(delta[0]?.fromSeq).toBe(ctx.held.seq)
    expect(delta[0]?.changes.map((c) => c.entityId)).toEqual(['s3'])
  })

  it('leaves the gap to the client heal rather than streaming it', async () => {
    const ctx = await servedOnce()
    // The head moves BEFORE the reconnect: the replica's cursor is now behind.
    await commit(ctx.p, 's3')
    const peer = await reconnect(ctx, ctx.held)

    // Still nothing but the grant. `(cursor, head]` is `/sync/delta`'s
    // — the read this client performs on every reconnect anyway — and a server
    // that ALSO streamed it would be the duplicate transfer this issue removes,
    // arriving as a delta instead of a world.
    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.of('feedResume')[0]?.seq).toBe(ctx.held.seq)
  })
})

describe('a cursor the log cannot serve is refused, and the refusal requests HTTP recovery', () => {
  it('refuses a cursor from a foreign feed', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, { ...ctx.held, feedId: 'someone-elses-feed' })

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.types()).toEqual(['feedResyncRequired'])
  })

  it('refuses a cursor presented against a rolled epoch', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, { ...ctx.held, epoch: 'epoch-from-before-the-reset' })

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.types()).toEqual(['feedResyncRequired'])
  })

  it('refuses a cursor from the future — the database was restored behind it', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, { ...ctx.held, seq: ctx.held.seq + 1 })

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.types()).toEqual(['feedResyncRequired'])
  })

  it('refuses a cursor below the retained floor, and serves it at the exact boundary', async () => {
    // `cursor + 1 >= minAvailableSeq` — change-log.ts's own spelling. At
    // `cursor === floor - 1` every row the client needs is still retained, so it
    // resumes; one lower and `(cursor, head]` has a hole no read can fill.
    const compacted = await servedOnce({ retention: { minAvailableSeq: () => 5 } })
    // Head above the floor, so the boundary being tested is the FLOOR and not
    // the "cursor from the future" refusal sitting in front of it.
    for (let i = 3; i <= 6; i += 1) await commit(compacted.p, `s${i}`)
    expect(await compacted.p.authority.cursor()).toBe(6)

    expect((await reconnect(compacted, { ...compacted.held, seq: 3 })).types()).not.toContain(
      'feedResume',
    )
    expect((await reconnect(compacted, { ...compacted.held, seq: 4 })).types()).toEqual([
      'feedResume',
    ])
  })

  it('grants the head to a cold HTTP hello that presents no cursor', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, undefined)

    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.of('feedResume')[0]?.seq).toBe(ctx.held.seq)
  })
})

describe('HTTP bootstrap capability', () => {
  it('grants the head to a cold peer and resumes three reconnects without a world', async () => {
    const ctx = await servedOnce()
    for (let i = 0; i < 4; i++) {
      const peer = new Peer(`http-${i}`, WIRE_VERSION, true, true)
      ctx.p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id), i === 0 ? undefined : ctx.held)
      await ctx.p.serving.admissionSettled()
      expect(peer.types()).toEqual(['feedResume'])
      expect(peer.of('feedResume')[0]?.seq).toBe(ctx.held.seq)
      ctx.p.serving.detach(peer.id)
    }
  })

  it('uses the HTTP rule when an already admitted peer changes wire version', async () => {
    const ctx = await servedOnce()
    const peer = new Peer('version-http', 1)
    ctx.p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id))
    await ctx.p.serving.admissionSettled()
    const upgraded = new Peer(peer.id, WIRE_VERSION, true, true)
    ctx.p.serving.renegotiate(upgraded, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id))
    await ctx.p.serving.admissionSettled()
    expect(upgraded.types()).toEqual(['feedResume'])
  })

  it('keeps live delivery after epoch demotion without another socket or world', async () => {
    const ctx = await servedOnce()
    const peer = new Peer('http-epoch', WIRE_VERSION, true, true)
    ctx.p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id), ctx.held)
    await ctx.p.serving.admissionSettled()
    await ctx.p.serving.bumpEpoch('restore')
    expect(peer.types()).toEqual(['feedResume', 'feedResyncRequired'])
    await commit(ctx.p, 's3')
    const delivery = await ctx.p.authority.changesSince(ctx.held.seq, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) throw new Error('missing range')
    await ctx.p.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)
    expect(peer.of('feedDelta')[0]?.seq).toBe(ctx.held.seq + 1)
    expect(peer.types().filter(type => type === 'feedBootstrap')).toHaveLength(0)
  })

  it.each(['feed', 'epoch', 'future', 'retention'])('refuses a %s cursor with resync and retains live delivery', async (reason) => {
    const ctx = await servedOnce({ retention: { minAvailableSeq: async () => 2 } })
    const cursor = { ...ctx.held }
    if (reason === 'feed') cursor.feedId = 'foreign'
    if (reason === 'epoch') cursor.epoch = 'foreign'
    if (reason === 'future') cursor.seq += 100
    if (reason === 'retention') cursor.seq = 0
    const peer = new Peer('http-refused', WIRE_VERSION, true, true)
    ctx.p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id), cursor)
    await ctx.p.serving.admissionSettled()
    expect(peer.types()).toEqual(['feedResyncRequired'])
    await commit(ctx.p, 's3')
    const delivery = await ctx.p.authority.changesSince(ctx.held.seq, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) throw new Error('missing range')
    await ctx.p.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)
    expect(peer.of('feedDelta')[0]?.fromSeq).toBe(ctx.held.seq)
    expect(peer.types().filter(type => type === 'feedBootstrap')).toHaveLength(0)
  })
})
