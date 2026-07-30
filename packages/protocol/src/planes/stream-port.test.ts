import { describe, expect, it, vi } from 'vitest'
import { asIssueId, asSessionId } from '@podium/model'
import type { PlaneTarget } from './control-port'
import {
  PRESENCE_PAYLOAD_MAX_BYTES,
  PRESENCE_PUBLISH_RATE_HZ,
  type PresenceRoomServerMessage,
  PresenceUpdateMessage,
  presencePayloadWithinBudget,
  RESERVED_ROOM_KINDS,
  ROOM_KINDS,
  RoomRef,
} from './presence-rooms'
import {
  asAgentIdentityId,
  asCapabilityRef,
  asDelegationRef,
  asDeviceId,
  asUserId,
  attributionOf,
  type Principal,
  type VisibilityResolver,
} from './principal'
import {
  asSubscriberId,
  controlEntityDelivery,
  PlaneRouter,
  principalRoutingKey,
  SubscriptionRegistry,
  streamLiveDelivery,
} from './routing'
import { presenceCoalesceKey, StreamPlanePort } from './stream-port'

const user = (id: string): Principal => ({
  kind: 'user',
  user: asUserId(id),
  device: asDeviceId(`${id}-d`),
  capability: asCapabilityRef('cap'),
})

const agent = (id: string, human: string): Principal => ({
  kind: 'agent',
  agentIdentity: asAgentIdentityId(id),
  onBehalfOf: asUserId(human),
  device: asDeviceId(`${id}-d`),
  capability: asCapabilityRef('cap'),
  delegation: asDelegationRef('del'),
})

const conn = (id: string, principal: Principal): PlaneTarget => ({
  subscriberId: asSubscriberId(id),
  principal,
})

const room: RoomRef = { kind: 'session', id: asSessionId('s1') }

const identityOf = (p: Principal) =>
  p.kind === 'agent'
    ? ({ kind: 'agent', agentIdentity: p.agentIdentity, onBehalfOf: p.onBehalfOf } as const)
    : ({ kind: 'user', user: p.kind === 'user' ? p.user : asUserId('none') } as const)

const setup = (visibility: VisibilityResolver = { canSee: () => true }) => {
  const registry = new SubscriptionRegistry()
  const router = new PlaneRouter<PresenceRoomServerMessage>(
    registry,
    streamLiveDelivery(4, presenceCoalesceKey, 2),
  )
  const emit = vi.fn()
  const port = new StreamPlanePort(registry, router, { visibility, emit, identityOf })
  return { registry, router, port, emit }
}

describe('rooms are entity references on the stream port', () => {
  it('keeps the room-kind set closed, with document reserved', () => {
    expect([...ROOM_KINDS]).toEqual(['session', 'issue'])
    expect([...RESERVED_ROOM_KINDS]).toEqual(['document'])
    // A free-string room name is unrepresentable, not merely discouraged.
    expect(RoomRef.safeParse({ kind: 'issue-42-sidebar', id: 'x' }).success).toBe(false)
    expect(RoomRef.safeParse({ kind: 'issue', id: asIssueId('i1') }).success).toBe(true)
  })

  it('declares stream · live and refuses a non-coalescing or foreign router', () => {
    const { port, registry } = setup()
    expect([...port.planeClasses]).toEqual(['stream.live'])

    const durable = new PlaneRouter<PresenceRoomServerMessage>(registry, controlEntityDelivery(2))
    expect(
      () =>
        new StreamPlanePort(registry, durable, {
          visibility: { canSee: () => true },
          emit: () => {},
          identityOf,
        }),
    ).toThrow(/stream.live/)

    const foreign = new PlaneRouter<PresenceRoomServerMessage>(
      new SubscriptionRegistry(),
      streamLiveDelivery(2, presenceCoalesceKey, 2),
    )
    expect(
      () =>
        new StreamPlanePort(registry, foreign, {
          visibility: { canSee: () => true },
          emit: () => {},
          identityOf,
        }),
    ).toThrow(/one subscription registry/)
  })
})

describe('joins are visibility-gated and default-closed (D14)', () => {
  it('answers a refused join and a nonexistent room with the IDENTICAL frame', () => {
    const invisible = setup({ canSee: () => false })
    expect(invisible.port.join(conn('a', user('alice')), room)).toBe(false)
    const refused = invisible.emit.mock.calls[0]?.[1]

    const missing = setup({ canSee: () => false })
    expect(
      missing.port.join(conn('a', user('alice')), { kind: 'session', id: asSessionId('nope') }),
    ).toBe(false)
    const notFound = missing.emit.mock.calls[0]?.[1]

    expect(refused.type).toBe('presenceRoomClosed')
    // No reason code anywhere: a subscribe frame must not be an existence oracle.
    expect(Object.keys(refused).sort()).toEqual(['room', 'type'])
    expect({ ...notFound, room: refused.room }).toEqual(refused)
  })

  it('does not subscribe a refused connection to anything', () => {
    const { port, registry } = setup({ canSee: () => false })
    port.join(conn('a', user('alice')), room)
    expect(registry.keyCount).toBe(0)
  })

  it('sends a full occupancy snapshot on join, including idle members (D10.5)', () => {
    const { port, emit } = setup()
    // Alice joins and never moves — an idle watcher.
    port.join(conn('a', user('alice')), room)
    emit.mockClear()

    port.join(conn('b', user('bob')), room)
    const snapshot = emit.mock.calls[0]?.[1]
    expect(snapshot.type).toBe('presenceRoomState')
    expect(snapshot.members).toHaveLength(2)
    // An idle room is distinguishable from an empty one — the whole reason the
    // snapshot exists.
    expect(
      snapshot.members.map((m: { identity: { user: string } }) => m.identity.user).sort(),
    ).toEqual(['alice', 'bob'])
  })

  it('evicts on visibility loss with the same one-shape frame (D14.4)', () => {
    const { port, registry, emit } = setup()
    const alice = conn('a', user('alice'))
    port.join(alice, room)
    emit.mockClear()
    port.evict(alice, room)
    expect(emit.mock.calls.at(-1)?.[1]).toEqual({ type: 'presenceRoomClosed', room })
    expect(registry.keyCount).toBe(0)
    expect(port.occupancy(room)).toEqual([])
  })
})

describe('presence is identity-carrying, with an opaque payload (D9)', () => {
  it('stamps identity from the transport; an inbound frame cannot carry one', () => {
    const parsed = PresenceUpdateMessage.parse({
      type: 'presenceUpdate',
      room,
      payload: { cursor: 3 },
      // A client trying to self-report an identity:
      user: 'mallory',
      identity: { kind: 'user', user: 'mallory' },
    })
    // Stripped at the schema boundary: a spoofed identity is unrepresentable.
    expect(Object.keys(parsed).sort()).toEqual(['payload', 'room', 'type'])

    const { port, router } = setup()
    const alice = conn('a', user('alice'))
    port.join(alice, room)
    router.drain(asSubscriberId('a'))
    port.publishPresence(alice, room, { cursor: 3 })
    const [member] = port.occupancy(room)
    expect(member?.identity).toEqual({ kind: 'user', user: 'alice' })
  })

  it('carries an agent’s attribution pair rather than a second identity concept', () => {
    const { port } = setup()
    const bot = agent('agent-7', 'alice')
    port.join(conn('bot', bot), room)
    expect(port.occupancy(room)[0]?.identity).toEqual({
      kind: 'agent',
      agentIdentity: 'agent-7',
      onBehalfOf: 'alice',
    })
    expect(attributionOf(bot)).toEqual({ actor: 'agent-7', onBehalfOf: 'alice' })
  })

  it('treats the payload as opaque, bounded, idempotent full state', () => {
    const { port } = setup()
    const alice = conn('a', user('alice'))
    port.join(alice, room)
    port.publishPresence(alice, room, { anything: { the: 'feature', owns: [1, 2, 3] } })
    expect(port.occupancy(room)[0]?.payload).toEqual({
      anything: { the: 'feature', owns: [1, 2, 3] },
    })

    // Over budget is REFUSED, not truncated: the port cannot bound what it
    // cannot measure.
    const huge = { blob: 'x'.repeat(PRESENCE_PAYLOAD_MAX_BYTES + 1) }
    expect(presencePayloadWithinBudget(huge)).toBe(false)
    port.publishPresence(alice, room, huge)
    expect(port.occupancy(room)[0]?.payload).toEqual({
      anything: { the: 'feature', owns: [1, 2, 3] },
    })

    // Latest-wins per member is the only ordering obligation.
    port.publishPresence(alice, room, { cursor: 9 })
    expect(port.occupancy(room)[0]?.payload).toEqual({ cursor: 9 })
    expect(PRESENCE_PUBLISH_RATE_HZ).toEqual({ min: 30, max: 60 })
  })

  it('ignores a publish into a room this connection has not joined', () => {
    const { port } = setup()
    port.publishPresence(conn('a', user('alice')), room, { cursor: 1 })
    expect(port.occupancy(room)).toEqual([])
  })
})

describe('membership is per principal and leaves are derived (D9.4/D10.6)', () => {
  it('counts two tabs as one member and only leaves on the last one', () => {
    const { port, router } = setup()
    const tab1 = conn('tab1', user('alice'))
    const tab2 = conn('tab2', user('alice'))
    const bob = conn('bob', user('bob'))
    port.join(bob, room)
    port.join(tab1, room)
    port.join(tab2, room)
    expect(port.occupancy(room)).toHaveLength(2)

    router.drain(asSubscriberId('bob'))
    port.leave(tab1, room)
    // The member is still here on its other connection: no leave notification.
    expect(router.drain(asSubscriberId('bob'))).toEqual([])
    expect(port.occupancy(room)).toHaveLength(2)

    port.leave(tab2, room)
    const [notice] = router.drain(asSubscriberId('bob')) as PresenceRoomServerMessage[]
    expect(notice).toMatchObject({ type: 'presenceRoomDelta', change: 'left' })
    expect(port.occupancy(room)).toHaveLength(1)
  })

  it('derives the leave from a killed connection — no ghost occupant survives', () => {
    const { port, router, registry } = setup()
    const bob = conn('bob', user('bob'))
    port.join(bob, room)
    port.join(conn('ghost', user('alice')), room)
    router.drain(asSubscriberId('bob'))

    port.disconnect(asSubscriberId('ghost'))
    const [notice] = router.drain(asSubscriberId('bob')) as PresenceRoomServerMessage[]
    expect(notice).toMatchObject({ type: 'presenceRoomDelta', change: 'left' })
    expect(port.occupancy(room).map((m) => m.identity)).toEqual([{ kind: 'user', user: 'bob' }])
    expect(registry.keysOf(asSubscriberId('ghost'))).toEqual([])
  })

  it('drops all presence state when the connection goes — nothing outlives it (D12)', () => {
    const { port, registry } = setup()
    port.join(conn('a', user('alice')), room)
    port.publishPresence(conn('a', user('alice')), room, { cursor: 1 })
    port.disconnect(asSubscriberId('a'))
    expect(port.occupancy(room)).toEqual([])
    expect(registry.keyCount).toBe(0)
    // Offline renders blank, not "last known".
  })
})

describe('today’s `visible` boolean maps forward (D9.5)', () => {
  it('answers "is THIS user watching?", not "is anybody watching?"', () => {
    const { port } = setup()
    const alice = conn('a', user('alice'))
    const bob = conn('b', user('bob'))
    port.join(alice, room)
    port.join(bob, room)

    port.publishPresence(alice, room, undefined, true)
    port.publishPresence(bob, room, undefined, false)

    // The shipped notification router's anonymous OR cannot make this
    // distinction; that is the correctness bug D9.5 fixes.
    expect(port.isWatchedBy(user('alice'))).toBe(true)
    expect(port.isWatchedBy(user('bob'))).toBe(false)
  })

  it('answers per user even for a connection that joined no room', () => {
    // Today's `{ type: 'presence', visible }` frame is room-less; the forward
    // mapping must keep working for a client that only reports page visibility.
    const { port } = setup()
    port.publishPresence(conn('a', user('alice')), room, undefined, true)
    expect(port.occupancy(room)).toEqual([])
    expect(port.isWatchedBy(user('alice'))).toBe(true)
    expect(port.isWatchedBy(user('bob'))).toBe(false)
  })

  it('carries the bit as a reserved field on the presence record, not a second frame', () => {
    const { port, router } = setup()
    const alice = conn('a', user('alice'))
    port.join(alice, room)
    router.drain(asSubscriberId('a'))
    port.publishPresence(alice, room, { cursor: 1 }, true)
    expect(port.occupancy(room)[0]).toMatchObject({ visible: true, payload: { cursor: 1 } })
  })
})

describe('room fan-out never touches the funnel or the oplog (D11.1)', () => {
  it('puts nothing on the durable pipe under a 200-update flood, and never demotes the replica', () => {
    const registry = new SubscriptionRegistry()
    const feedRouter = new PlaneRouter<{ seq: number }>(registry, controlEntityDelivery(4))
    const presenceRouter = new PlaneRouter<PresenceRoomServerMessage>(
      registry,
      streamLiveDelivery(4, presenceCoalesceKey, 2),
    )
    const port = new StreamPlanePort(registry, presenceRouter, {
      visibility: { canSee: () => true },
      emit: () => {},
      identityOf,
    })
    const alice = conn('a', user('alice'))
    registry.subscribe(principalRoutingKey(user('alice')), {
      subscriberId: asSubscriberId('a'),
      principal: user('alice'),
    })
    port.join(alice, room)

    for (let i = 0; i < 200; i++) port.publishPresence(alice, room, { cursor: i })

    // Nothing arrived on the durable pipe, and the durable subscriber was never
    // demoted by presence traffic.
    expect(feedRouter.queued(asSubscriberId('a'))).toBe(0)
    expect(feedRouter.isDemoted(asSubscriberId('a'))).toBe(false)
  })

  it('gives join and update ONE coalescing identity per member, and keeps leave distinct', () => {
    const left = presenceCoalesceKey({
      type: 'presenceRoomDelta',
      room,
      change: 'left',
      member: { identity: { kind: 'user', user: asUserId('alice') } },
    })
    const updated = presenceCoalesceKey({
      type: 'presenceRoomDelta',
      room,
      change: 'updated',
      member: { identity: { kind: 'user', user: asUserId('alice') } },
    })
    const joined = presenceCoalesceKey({
      type: 'presenceRoomDelta',
      room,
      change: 'joined',
      member: { identity: { kind: 'user', user: asUserId('alice') } },
    })
    // join and update collapse into one another; a leave must not be coalesced
    // away by a stale update.
    expect(joined).toBe(updated)
    expect(left).not.toBe(updated)
  })
})
