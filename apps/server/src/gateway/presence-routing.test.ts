import { asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import {
  asSubscriberId,
  principalRoutingKey,
  type RoomRef,
  SubscriptionRegistry,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { userClientPrincipal } from './client-principal'
import type { ClientConn } from './client-registry'
import { ClientRegistry } from './client-registry'
import { PresenceRouting, STREAM_EVICT_AFTER_DROPS } from './presence-routing'

const ROOM: RoomRef = { kind: 'session', id: asSessionId('session-room') }

function connection(
  id: string,
  stream: (message: Parameters<ClientConn['send']>[0]) => boolean = () => true,
): { conn: ClientConn; sent: Parameters<ClientConn['send']>[0][] } {
  const sent: Parameters<ClientConn['send']>[0][] = []
  const conn: ClientConn = {
    id,
    principal: userClientPrincipal(id, FIRST_ADMIN_USER_ID, 'admin'),
    send: (message) => {
      sent.push(message)
    },
    sendStream: (message) => {
      sent.push(message)
      return stream(message)
    },
    publicationBootstrapped: false,
    publicationPending: false,
    publicationRequestVersion: 0,
    publicationBufferedChanges: [],
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

function setup(opts: { visible?: boolean; now?: () => number } = {}) {
  const subscriptions = new SubscriptionRegistry()
  const clients = new ClientRegistry()
  const presence = new PresenceRouting({
    subscriptions,
    clients,
    visibility: { canSee: () => opts.visible ?? true },
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
