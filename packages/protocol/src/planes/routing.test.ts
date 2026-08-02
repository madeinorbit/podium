import { describe, expect, it } from 'vitest'
import {
  asCapabilityRef,
  asDeviceId,
  asUserId,
  type Principal,
  principalRoutingId,
} from './principal'
import {
  asSubscriberId,
  controlEntityDelivery,
  entityRoutingKey,
  parseEntityRoutingKey,
  parseRoomRoutingKey,
  PlaneRouter,
  principalRoutingKey,
  principalRoutingKeyFromId,
  roomRoutingKey,
  SubscriptionRegistry,
  streamLiveDelivery,
} from './routing'

// Parts chosen to attack the escaping: each contains the separator, the escape
// character, or a shape that would look like a valid multi-part key on its own.
// Same battery as packages/model/src/ids/keys.test.ts (POD-1134).
const HOSTILE = ['a:b', 'a\\b', 'a\nb', '\\', ':', '\n', 'a\\:b', '', 'x:y:z']

const user = (id: string, device = `${id}-d1`): Principal => ({
  kind: 'user',
  user: asUserId(id),
  device: asDeviceId(device),
  capability: asCapabilityRef('cap'),
})

interface Frame {
  readonly seq: number
  readonly member?: string
}

describe('routing key constructors — injective over hostile parts (POD-1134)', () => {
  it('entityRoutingKey round-trips every hostile kind/id pair', () => {
    for (const kind of HOSTILE.filter((p) => p !== '')) {
      for (const id of HOSTILE.filter((p) => p !== '')) {
        expect(parseEntityRoutingKey(entityRoutingKey({ kind, id }))).toEqual({ kind, id })
      }
    }
  })

  it('roomRoutingKey round-trips every hostile kind/id pair', () => {
    for (const kind of HOSTILE.filter((p) => p !== '')) {
      for (const id of HOSTILE.filter((p) => p !== '')) {
        expect(parseRoomRoutingKey(roomRoutingKey({ kind, id }))).toEqual({ kind, id })
      }
    }
  })

  it('is injective: no two distinct (kind, id) pairs collide on one entity key', () => {
    const seen = new Map<string, [string, string]>()
    for (const kind of HOSTILE.filter((p) => p !== '')) {
      for (const id of HOSTILE.filter((p) => p !== '')) {
        const key = entityRoutingKey({ kind, id })
        const prior = seen.get(key)
        expect(prior, `collision on ${JSON.stringify(key)}`).toBeUndefined()
        seen.set(key, [kind, id])
      }
    }
  })

  it('separates the classic colon-collision pairs that unescaped concat merges', () => {
    // kind='a', id='b:c' vs kind='a:b', id='c' — the defect this issue ends.
    expect(entityRoutingKey({ kind: 'a', id: 'b:c' })).not.toBe(
      entityRoutingKey({ kind: 'a:b', id: 'c' }),
    )
    expect(roomRoutingKey({ kind: 'a', id: 'b:c' })).not.toBe(
      roomRoutingKey({ kind: 'a:b', id: 'c' }),
    )
  })

  it('keeps the legacy byte shape when no part contains the separator or a backslash', () => {
    // Adoption property: in-memory keys for ordinary ids stay byte-identical so
    // live registries do not need a dual-read window for the POD-1134 flip.
    expect(entityRoutingKey({ kind: 'issue', id: 'i1' })).toBe('entity:issue:i1')
    expect(roomRoutingKey({ kind: 'session', id: 's1' })).toBe('room:session:s1')
    expect(principalRoutingKeyFromId('user:alice:d1')).toBe('principal:user:alice:d1')
  })

  it('refuses empty kind or id rather than building an unparseable key', () => {
    expect(() => entityRoutingKey({ kind: '', id: 'x' })).toThrow(/must not be empty/)
    expect(() => entityRoutingKey({ kind: 'issue', id: '' })).toThrow(/must not be empty/)
    expect(() => roomRoutingKey({ kind: 'session', id: '' })).toThrow(/must not be empty/)
  })

  it('namespaces stay distinct: entity, room, and principal never share a key', () => {
    const ref = { kind: 'session', id: 's1' }
    expect(entityRoutingKey(ref)).not.toBe(roomRoutingKey(ref))
    expect(entityRoutingKey(ref)).not.toBe(principalRoutingKeyFromId('session:s1'))
    expect(roomRoutingKey(ref)).not.toBe(principalRoutingKeyFromId('session:s1'))
  })
})

describe('ADR 7 Amendment 1 D13 — ONE routing primitive, parameterized by durability', () => {
  it('routes the scoped feed and room presence through the SAME registry instance', () => {
    const registry = new SubscriptionRegistry()
    const entity = new PlaneRouter<Frame>(registry, controlEntityDelivery(8))
    const presence = new PlaneRouter<Frame>(
      registry,
      streamLiveDelivery(4, (f) => f.member ?? 'x', 3),
    )

    // By construction, not by assertion: both routers hold the one table.
    expect(entity.registry).toBe(registry)
    expect(presence.registry).toBe(registry)

    const alice = asSubscriberId('conn-a')
    registry.subscribe(entityRoutingKey({ kind: 'issue', id: 'i1' }), {
      subscriberId: alice,
      principal: user('alice'),
    })
    registry.subscribe(roomRoutingKey({ kind: 'issue', id: 'i1' }), {
      subscriberId: alice,
      principal: user('alice'),
    })

    // One registry, two key namespaces — the entity key and the room key over
    // the same entity are distinct routing sets, not one blurred set.
    expect(registry.keyCount).toBe(2)
    expect(registry.keysOf(alice)).toHaveLength(2)
    expect(
      entity.publish(entityRoutingKey({ kind: 'issue', id: 'i1' }), { seq: 1 }).delivered,
    ).toEqual([alice])
    expect(
      presence.publish(roomRoutingKey({ kind: 'issue', id: 'i1' }), { seq: 1, member: 'alice' })
        .delivered,
    ).toEqual([alice])
  })

  it('refuses a router whose durability contradicts its plane class', () => {
    const registry = new SubscriptionRegistry()
    expect(
      () =>
        new PlaneRouter<Frame>(registry, {
          planeClass: 'stream.live',
          durability: 'durable',
          maxQueued: 2,
          onOverflow: 'demote-to-resync',
        }),
    ).toThrow(/lossy/)
    expect(
      () =>
        new PlaneRouter<Frame>(registry, {
          planeClass: 'control.entity',
          durability: 'ephemeral',
          maxQueued: 2,
          onOverflow: 'evict',
        }),
    ).toThrow()
  })

  it('forbids coalescing on the durable side — contiguity is certified per frame', () => {
    const registry = new SubscriptionRegistry()
    expect(
      () =>
        new PlaneRouter<Frame>(registry, {
          ...controlEntityDelivery<Frame>(4),
          coalesceKey: (f) => String(f.seq),
        }),
    ).toThrow(/coalesce/)
  })

  it('requires membership to be per principal, not per connection (D9.4)', () => {
    const registry = new SubscriptionRegistry()
    const key = roomRoutingKey({ kind: 'session', id: 's1' })
    const alice = user('alice')
    registry.subscribe(key, { subscriberId: asSubscriberId('tab1'), principal: alice })
    registry.subscribe(key, { subscriberId: asSubscriberId('tab2'), principal: alice })
    registry.subscribe(key, { subscriberId: asSubscriberId('bob'), principal: user('bob') })

    expect(registry.subscribers(key)).toHaveLength(3)
    // Two tabs are ONE member with two connections.
    expect(registry.members(key).size).toBe(2)
    expect(registry.members(key).get(principalRoutingId(alice))).toHaveLength(2)
  })

  it('drops every subscription a closed connection held, across both key spaces', () => {
    const registry = new SubscriptionRegistry()
    const conn = asSubscriberId('conn')
    const k1 = roomRoutingKey({ kind: 'session', id: 's1' })
    const k2 = entityRoutingKey({ kind: 'issue', id: 'i1' })
    registry.subscribe(k1, { subscriberId: conn, principal: user('alice') })
    registry.subscribe(k2, { subscriberId: conn, principal: user('alice') })

    expect(registry.dropSubscriber(conn).sort()).toEqual([k2, k1].sort())
    expect(registry.keyCount).toBe(0)
    expect(registry.subscriberCount).toBe(0)
  })

  it('gives an agent principal its own routing identity, distinct from its human', () => {
    const agent: Principal = {
      kind: 'agent',
      agentIdentity: 'agent-7' as never,
      onBehalfOf: asUserId('alice'),
      device: asDeviceId('d'),
      capability: asCapabilityRef('cap'),
      delegation: 'del-1' as never,
    }
    expect(principalRoutingId(agent)).not.toBe(principalRoutingId(user('alice')))
  })
})

describe('the durable side: control · entity delivery', () => {
  const setup = () => {
    const registry = new SubscriptionRegistry()
    const router = new PlaneRouter<Frame>(registry, controlEntityDelivery(3))
    const conn = asSubscriberId('replica')
    const key = entityRoutingKey({ kind: 'session', id: 's1' })
    registry.subscribe(key, { subscriberId: conn, principal: user('alice') })
    return { registry, router, conn, key }
  }

  it('never drops or reorders a frame: delivery is ordered and complete', () => {
    const { router, conn, key } = setup()
    for (const seq of [1, 2, 3]) router.publish(key, { seq })
    expect(router.drain(conn).map((f) => f.seq)).toEqual([1, 2, 3])
  })

  it('demotes to resync under pressure instead of silently dropping (ADR 2 D9)', () => {
    const { router, conn, key } = setup()
    for (const seq of [1, 2, 3]) router.publish(key, { seq })
    const outcome = router.publish(key, { seq: 4 })

    expect(outcome.dropped).toEqual([])
    expect(outcome.demoted).toEqual([conn])
    expect(router.isDemoted(conn)).toBe(true)
    // The subscription survives the demotion: the replica heals, it is not evicted.
    expect(outcome.evicted).toEqual([])
    expect(router.registry.has(key, conn)).toBe(true)
  })
})

describe('the lossy side: stream · live room fan-out', () => {
  const setup = (maxQueued = 2, evictAfter = 2) => {
    const registry = new SubscriptionRegistry()
    const router = new PlaneRouter<Frame>(
      registry,
      streamLiveDelivery(maxQueued, (f) => f.member ?? 'x', evictAfter),
    )
    const conn = asSubscriberId('watcher')
    const key = roomRoutingKey({ kind: 'session', id: 's1' })
    registry.subscribe(key, { subscriberId: conn, principal: user('bob') })
    return { registry, router, conn, key }
  }

  it('coalesces latest-wins per member before considering a drop (D11.3)', () => {
    const { router, conn, key } = setup()
    router.publish(key, { seq: 1, member: 'alice' })
    const outcome = router.publish(key, { seq: 2, member: 'alice' })

    expect(outcome.coalesced).toEqual([conn])
    expect(router.queued(conn)).toBe(1)
    expect(router.drain(conn).map((f) => f.seq)).toEqual([2])
  })

  it('escalates coalesce → drop → evict from the room, and never terminates', () => {
    const { router, conn, key } = setup(1, 2)
    router.publish(key, { seq: 1, member: 'alice' })
    const first = router.publish(key, { seq: 2, member: 'bob' })
    expect(first.dropped).toEqual([conn])
    expect(first.evicted).toEqual([])

    const second = router.publish(key, { seq: 3, member: 'carol' })
    expect(second.dropped).toEqual([conn])
    expect(second.evicted).toEqual([conn])
    // Evicted from THIS key only; the connection itself survives.
    expect(router.registry.has(key, conn)).toBe(false)
    expect(router.isDemoted(conn)).toBe(false)
  })

  it('a presence flood does not touch control delivery on the same connection', () => {
    const registry = new SubscriptionRegistry()
    const entity = new PlaneRouter<Frame>(registry, controlEntityDelivery(4))
    const presence = new PlaneRouter<Frame>(
      registry,
      streamLiveDelivery(1, (f) => f.member ?? 'x', 2),
    )
    const conn = asSubscriberId('conn')
    const room = roomRoutingKey({ kind: 'session', id: 's1' })
    const feed = principalRoutingKey(user('alice'))
    registry.subscribe(room, { subscriberId: conn, principal: user('alice') })
    registry.subscribe(feed, { subscriberId: conn, principal: user('alice') })

    for (let i = 0; i < 50; i++) presence.publish(room, { seq: i, member: `m${i}` })
    const outcome = entity.publish(feed, { seq: 1 })

    expect(outcome.delivered).toEqual([conn])
    expect(entity.isDemoted(conn)).toBe(false)
    expect(entity.drain(conn).map((f) => f.seq)).toEqual([1])
    // The room subscription is what gave way, not the feed.
    expect(registry.has(feed, conn)).toBe(true)
    expect(registry.has(room, conn)).toBe(false)
  })
})
