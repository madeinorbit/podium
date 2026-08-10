import { asSessionId, asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import {
  asSubscriberId,
  principalRoutingKey,
  type Principal,
  type RoomRef,
  SubscriptionRegistry,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { userClientPrincipal } from './client-principal'
import type { ClientConn } from './client-registry'
import { ClientRegistry } from './client-registry'
import {
  PresenceRouting,
  STREAM_EVICT_AFTER_DROPS,
  STREAM_QUEUE_MAX_FRAMES,
} from './presence-routing'

const ROOM: RoomRef = { kind: 'session', id: asSessionId('session-room') }

function connection(
  id: string,
  stream: (message: Parameters<ClientConn['send']>[0]) => boolean = () => true,
  user: UserId = FIRST_ADMIN_USER_ID,
): { conn: ClientConn; sent: Parameters<ClientConn['send']>[0][] } {
  const sent: Parameters<ClientConn['send']>[0][] = []
  const conn: ClientConn = {
    id,
    principal: userClientPrincipal(id, user, 'member'),
    send: (message) => {
      sent.push(message)
    },
    sendStream: (message) => {
      sent.push(message)
      return stream(message)
    },
    viewports: new Map(),
    attached: new Set(),
    caps: new Set(),
    wireVersion: 2,
    transcriptSubs: new Set(),
    visible: false,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
  }
  return { conn, sent }
}

function setup(
  opts: { visible?: boolean | ((principal: Principal) => boolean); now?: () => number } = {},
) {
  const subscriptions = new SubscriptionRegistry()
  const clients = new ClientRegistry()
  const presence = new PresenceRouting({
    subscriptions,
    clients,
    visibility: {
      canSee: (principal) =>
        typeof opts.visible === 'function' ? opts.visible(principal) : (opts.visible ?? true),
    },
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { subscriptions, clients, presence }
}

describe('production presence routing', () => {
  it('joins with a transport-stamped identity and echoes the stream token', () => {
    const { clients, presence } = setup()
    const alice = connection('alice')
    clients.add(alice.conn)

    presence.route(alice.conn, { type: 'presenceSubscribe', room: ROOM, token: 'join-1' })

    expect(alice.sent.at(-1)).toEqual({
      type: 'presenceRoomState',
      room: ROOM,
      members: [{ identity: { kind: 'user', user: FIRST_ADMIN_USER_ID } }],
      token: 'join-1',
    })
  })

  it('answers hidden and nonexistent rooms with the same non-distinguishing shape', () => {
    const hidden = setup({ visible: false })
    const unknown = setup({ visible: false })
    const a = connection('a')
    const b = connection('b')
    hidden.clients.add(a.conn)
    unknown.clients.add(b.conn)

    hidden.presence.route(a.conn, { type: 'presenceSubscribe', room: ROOM })
    unknown.presence.route(b.conn, { type: 'presenceSubscribe', room: ROOM })

    expect(a.sent.at(-1)).toEqual({ type: 'presenceRoomClosed', room: ROOM })
    expect(b.sent.at(-1)).toEqual(a.sent.at(-1))
  })

  it('does not reveal a present user to a second user who cannot see the room', () => {
    const aliceId = asUserId('user:alice')
    const bobId = asUserId('user:bob')
    const { clients, presence } = setup({
      visible: (principal) => principal.kind === 'user' && principal.user === aliceId,
    })
    const alice = connection('alice', () => true, aliceId)
    const bob = connection('bob', () => true, bobId)
    clients.add(alice.conn)
    clients.add(bob.conn)

    presence.route(alice.conn, { type: 'presenceSubscribe', room: ROOM })
    alice.sent.length = 0
    presence.route(alice.conn, {
      type: 'presenceUpdate',
      room: ROOM,
      payload: { cursor: 7 },
    })
    presence.flushNow()

    // Positive control: Alice's identity-carrying presence is genuinely live
    // and reaches the authorized subscriber before Bob attempts the same join.
    expect(alice.sent).toContainEqual({
      type: 'presenceRoomDelta',
      room: ROOM,
      change: 'updated',
      member: { identity: { kind: 'user', user: aliceId }, payload: { cursor: 7 } },
    })

    presence.route(bob.conn, { type: 'presenceSubscribe', room: ROOM })

    expect(bob.sent).toEqual([{ type: 'presenceRoomClosed', room: ROOM }])
  })

  it('shares one registry with the principal feed and derives all leaves on disconnect', () => {
    const { subscriptions, clients, presence } = setup()
    const alice = connection('alice')
    clients.add(alice.conn)
    subscriptions.subscribe(principalRoutingKey(alice.conn.principal), {
      subscriberId: asSubscriberId(alice.conn.id),
      principal: alice.conn.principal,
    })
    presence.route(alice.conn, { type: 'presenceSubscribe', room: ROOM })

    expect(subscriptions.keyCount).toBe(2)
    presence.disconnect(alice.conn)
    presence.flushNow()

    expect(subscriptions.keyCount).toBe(0)
    expect(presence.occupancy(ROOM)).toEqual([])
  })

  it('evicts stale rooms when the durable feed reports a rights change', () => {
    let visible = true
    const { subscriptions, clients, presence } = setup({ visible: () => visible })
    const alice = connection('alice')
    clients.add(alice.conn)
    subscriptions.subscribe(principalRoutingKey(alice.conn.principal), {
      subscriberId: asSubscriberId(alice.conn.id),
      principal: alice.conn.principal,
    })
    presence.route(alice.conn, { type: 'presenceSubscribe', room: ROOM })
    alice.sent.length = 0

    visible = false
    presence.revalidateSubscribers([asSubscriberId(alice.conn.id)])
    presence.flushNow()

    expect(
      subscriptions.has(principalRoutingKey(alice.conn.principal), asSubscriberId(alice.conn.id)),
    ).toBe(true)
    expect(
      subscriptions
        .keysOf(asSubscriberId(alice.conn.id))
        .some((key) => String(key).startsWith('room:')),
    ).toBe(false)
    expect(presence.occupancy(ROOM)).toEqual([])
    expect(alice.sent).toContainEqual({ type: 'presenceRoomClosed', room: ROOM })
  })

  it('drops a pressured stream and evicts only its room subscription', () => {
    let now = 0
    const { subscriptions, clients, presence } = setup({ now: () => now })
    const slow = connection('slow', () => false)
    const actor = connection('actor')
    clients.add(slow.conn)
    clients.add(actor.conn)
    subscriptions.subscribe(principalRoutingKey(slow.conn.principal), {
      subscriberId: asSubscriberId(slow.conn.id),
      principal: slow.conn.principal,
    })
    presence.route(slow.conn, { type: 'presenceSubscribe', room: ROOM })
    presence.route(actor.conn, { type: 'presenceSubscribe', room: ROOM })
    slow.sent.length = 0

    for (let i = 0; i < STREAM_EVICT_AFTER_DROPS; i += 1) {
      now += 20
      presence.route(actor.conn, {
        type: 'presenceUpdate',
        room: ROOM,
        payload: { cursor: i },
      })
      presence.flushNow()
    }

    expect(
      subscriptions.has(principalRoutingKey(slow.conn.principal), asSubscriberId('slow')),
    ).toBe(true)
    expect(
      subscriptions.keysOf(asSubscriberId('slow')).some((key) => String(key).startsWith('room:')),
    ).toBe(false)
    expect(clients.get('slow')).toBe(slow.conn)
  })

  it('bounds the undrained outbound queue so a busy room drops rather than buffers', () => {
    // Production policy: STREAM_QUEUE_MAX_FRAMES is the depth bound that keeps
    // presence from starving the control plane (ADR 7 Am1 / readiness 3.4).
    // A mutation that raises it to 1e6 must fail this test — so the flood size
    // is a hard number above 64, not `STREAM_QUEUE_MAX_FRAMES + k` (which would
    // scale with the mutant and still pass).
    expect(STREAM_QUEUE_MAX_FRAMES).toBe(64)

    const { subscriptions, clients, presence } = setup()
    // Socket accepts every frame. This is not the send-failure path exercised
    // above; frames pile up only because we refuse to drain.
    const watcher = connection('watcher', () => true, asUserId('user:watcher'))
    clients.add(watcher.conn)
    presence.route(watcher.conn, { type: 'presenceSubscribe', room: ROOM })
    presence.flushNow()
    watcher.sent.length = 0

    // Distinct members → distinct coalesce keys, so latest-wins cannot collapse
    // the flood into one slot. 80 sits between the real bound (64) and any
    // million-scale mutant.
    const flood = 80
    const actors = Array.from({ length: flood }, (_, i) => {
      const actor = connection(`actor-${i}`, () => true, asUserId(`user:actor-${i}`))
      clients.add(actor.conn)
      presence.route(actor.conn, { type: 'presenceSubscribe', room: ROOM })
      // Drain join fan-out so the depth bound is measured on the update storm.
      presence.flushNow()
      return actor
    })

    for (let i = 0; i < flood; i += 1) {
      presence.route(actors[i]!.conn, {
        type: 'presenceUpdate',
        room: ROOM,
        payload: { cursor: i },
      })
      // Deliberately no flushNow: the router queue is the thing under test.
    }

    // Coalesce → drop → evict from the room once the undrained queue is full
    // for STREAM_EVICT_AFTER_DROPS consecutive non-coalescing frames. A 1e6
    // queue would still hold every frame and keep the subscription.
    expect(
      subscriptions
        .keysOf(asSubscriberId('watcher'))
        .some((key) => String(key).startsWith('room:')),
    ).toBe(false)
    // Presence overload never tears down the connection or its other planes.
    expect(clients.get('watcher')).toBe(watcher.conn)
    expect(watcher.sent).toContainEqual({ type: 'presenceRoomClosed', room: ROOM })
  })

  it('caps inbound cursor publication at 60Hz instead of buffering it', () => {
    const now = 10
    const { clients, presence } = setup({ now: () => now })
    const alice = connection('alice')
    clients.add(alice.conn)
    presence.route(alice.conn, { type: 'presenceSubscribe', room: ROOM })
    alice.sent.length = 0

    presence.route(alice.conn, {
      type: 'presenceUpdate',
      room: ROOM,
      payload: { cursor: 1 },
    })
    for (let cursor = 2; cursor < 100; cursor += 1) {
      presence.route(alice.conn, {
        type: 'presenceUpdate',
        room: ROOM,
        payload: { cursor },
      })
    }
    presence.flushNow()

    expect(presence.occupancy(ROOM)[0]?.payload).toEqual({ cursor: 1 })
    expect(alice.sent.filter((message) => message.type === 'presenceRoomDelta')).toHaveLength(1)
  })

  it('retains no presence across disconnect or a fresh registry', () => {
    const first = setup()
    const alice = connection('alice')
    first.clients.add(alice.conn)
    first.presence.route(alice.conn, { type: 'presenceSubscribe', room: ROOM })
    first.presence.disconnect(alice.conn)

    const restarted = setup()
    expect(first.presence.occupancy(ROOM)).toEqual([])
    expect(restarted.presence.occupancy(ROOM)).toEqual([])
  })
})
