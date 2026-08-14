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

const commit = (p: ReturnType<typeof feedTestPlumbing>, id: string) =>
  p.ledger.commit({
    write: () => {},
    changes: () => [{ entity: 'session', id, op: 'upsert', value: { sessionId: id } }],
  })

/** A populated server, and a peer already admitted the ordinary way — the state
 *  every one of these cases reconnects INTO. */
function servedOnce(opts: Parameters<typeof feedTestPlumbing>[0] = {}) {
  const p = feedTestPlumbing(opts)
  commit(p, 's1')
  commit(p, 's2')
  const cold = new Peer('cold')
  p.serving.attach(cold, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(cold.id))
  const identity = p.serving.identity()
  const held: FeedCursorField = {
    feedId: identity.feedId,
    epoch: identity.epoch,
    seq: p.authority.cursor(),
  }
  return { p, cold, held }
}

/** Reconnect a NEW peer presenting `cursor`. A reconnect is a new socket and
 *  therefore a new peer id; reusing the old one would take the idempotent
 *  re-attach path and prove nothing. */
function reconnect(
  ctx: ReturnType<typeof servedOnce>,
  cursor: FeedCursorField | undefined,
  wireVersion: number = WIRE_VERSION,
): Peer {
  const peer = new Peer(`resumed-${wireVersion}-${cursor?.seq ?? 'none'}`, wireVersion)
  ctx.p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id), cursor)
  return peer
}

describe('a cursor the log can serve is answered with a resume, not a world', () => {
  it('sends one feedResume and not one row of the world', () => {
    const ctx = servedOnce()
    // The counterfactual, in the same test: the cold peer that was admitted
    // WITHOUT a cursor received the world, so "no bootstrap" below is a property
    // of the cursor and not of an empty server.
    expect(ctx.cold.of('feedBootstrap').flatMap((f) => f.changes)).toHaveLength(2)

    const peer = reconnect(ctx, ctx.held)

    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.of('feedResume')[0]).toEqual({
      type: 'feedResume',
      feedId: ctx.held.feedId,
      epoch: ctx.held.epoch,
      seq: ctx.held.seq,
    })
  })

  it('frames the next delta from the position it granted', () => {
    const ctx = servedOnce()
    const peer = reconnect(ctx, ctx.held)

    commit(ctx.p, 's3')
    const delivery = ctx.p.authority.changesSince(ctx.held.seq, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) throw new Error('the log could not serve from that cursor')
    ctx.p.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)

    // CHAINS ONTO WHAT THE REPLICA HOLDS. `fromSeq === cursor.seq` is the exact
    // acceptance rule (ADR 2 Am1 D13), so this frame applies without a heal —
    // the socket alone carries the replica forward, and the HTTP catch-up is the
    // shortcut for `(cursor, head]` rather than the only route.
    const delta = peer.of('feedDelta')
    expect(delta).toHaveLength(1)
    expect(delta[0]?.fromSeq).toBe(ctx.held.seq)
    expect(delta[0]?.changes.map((c) => c.entityId)).toEqual(['s3'])
  })

  it('leaves the gap to the client heal rather than streaming it', () => {
    const ctx = servedOnce()
    // The head moves BEFORE the reconnect: the replica's cursor is now behind.
    commit(ctx.p, 's3')
    const peer = reconnect(ctx, ctx.held)

    // Still nothing but the grant. `(cursor, head]` is `sync.feedChangesSince`'s
    // — the read this client performs on every reconnect anyway — and a server
    // that ALSO streamed it would be the duplicate transfer this issue removes,
    // arriving as a delta instead of a world.
    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.of('feedResume')[0]?.seq).toBe(ctx.held.seq)
  })
})

describe('a cursor the log cannot serve is refused, and the refusal is the world', () => {
  it('refuses a cursor from a foreign feed', () => {
    const ctx = servedOnce()
    const peer = reconnect(ctx, { ...ctx.held, feedId: 'someone-elses-feed' })

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.of('feedBootstrap').flatMap((f) => f.changes)).toHaveLength(2)
  })

  it('refuses a cursor presented against a rolled epoch', () => {
    const ctx = servedOnce()
    const peer = reconnect(ctx, { ...ctx.held, epoch: 'epoch-from-before-the-reset' })

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.of('feedBootstrap')).not.toHaveLength(0)
  })

  it('refuses a cursor from the future — the database was restored behind it', () => {
    const ctx = servedOnce()
    const peer = reconnect(ctx, { ...ctx.held, seq: ctx.held.seq + 1 })

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.of('feedBootstrap')).not.toHaveLength(0)
  })

  it('refuses a cursor below the retained floor, and serves it at the exact boundary', () => {
    // `cursor + 1 >= minAvailableSeq` — change-log.ts's own spelling. At
    // `cursor === floor - 1` every row the client needs is still retained, so it
    // resumes; one lower and `(cursor, head]` has a hole no read can fill.
    const compacted = servedOnce({ retention: { minAvailableSeq: () => 5 } })
    // Head above the floor, so the boundary being tested is the FLOOR and not
    // the "cursor from the future" refusal sitting in front of it.
    for (let i = 3; i <= 6; i += 1) commit(compacted.p, `s${i}`)
    expect(compacted.p.authority.cursor()).toBe(6)

    expect(reconnect(compacted, { ...compacted.held, seq: 3 }).types()).not.toContain('feedResume')
    expect(reconnect(compacted, { ...compacted.held, seq: 4 }).types()).toEqual(['feedResume'])
  })

  it('refuses a cursor from a wire that cannot be told it was accepted', () => {
    const ctx = servedOnce()
    const peer = reconnect(ctx, ctx.held, 1)

    // A v1 peer cannot send a cursor and its adapter has nothing to translate a
    // grant into, so a cursor arriving on one is answered the way it was before
    // anyone thought to ask: with the world, folded into v1's own messages.
    expect(peer.types()).not.toContain('feedResume')
    expect(peer.types()).toContain('sessionsChanged')
  })

  it('serves the world to a hello that presents nothing — the pre-POD-2061 client', () => {
    const ctx = servedOnce()
    const peer = reconnect(ctx, undefined)

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.of('feedBootstrap').flatMap((f) => f.changes)).toHaveLength(2)
  })
})

describe('the transfer a reconnect actually costs', () => {
  it('is O(delta) at an unchanged head, where it was O(world)', () => {
    const p = feedTestPlumbing()
    for (let i = 0; i < 50; i += 1) commit(p, `s${i}`)

    const cold = new Peer('cold')
    p.serving.attach(cold, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(cold.id))
    const identity = p.serving.identity()
    const resumed = new Peer('resumed')
    p.serving.renegotiate(resumed, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(resumed.id), {
      feedId: identity.feedId,
      epoch: identity.epoch,
      seq: p.authority.cursor(),
    })

    // Counted in ROWS and in BYTES, because the point of the finding was both: a
    // world is read, serialized and transferred, and the resumed peer pays for
    // none of it.
    const rows = (peer: Peer) =>
      peer.of('feedBootstrap').reduce((n, frame) => n + frame.changes.length, 0)
    const bytes = (peer: Peer) =>
      peer.received.reduce((n, message) => n + JSON.stringify(message).length, 0)

    expect(rows(cold)).toBe(50)
    expect(rows(resumed)).toBe(0)
    expect(bytes(resumed)).toBeLessThan(bytes(cold) / 10)
  })
})
