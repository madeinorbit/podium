import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { ClientSubscriptionRegistry } from './subscriptions'

describe('ClientSubscriptionRegistry', () => {
  it('uses one registry for the durable feed and lossy room subscriptions', () => {
    const registry = new ClientSubscriptionRegistry(true)
    const room = { kind: 'session' as const, id: asSessionId('s1') }

    registry.subscribeRoom(room, { cursor: { row: 4, col: 8 } }, true)

    expect(registry.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ durability: 'durable' }),
        expect.objectContaining({ durability: 'ephemeral', room }),
      ]),
    )
    expect(registry.snapshot()).toHaveLength(2)
  })

  it('restores only ephemeral room frames while durable feed membership stays implicit', () => {
    const registry = new ClientSubscriptionRegistry(true)
    const room = { kind: 'session' as const, id: asSessionId('s1') }
    registry.subscribeRoom(room, { cursor: 3 }, false)

    expect(registry.reconnectFrames()).toEqual([
      { type: 'presenceSubscribe', room },
      { type: 'presenceUpdate', room, payload: { cursor: 3 }, visible: false },
    ])
  })

  it('drops every durability class on principal change', () => {
    const registry = new ClientSubscriptionRegistry(true)
    registry.subscribeRoom({ kind: 'session', id: asSessionId('s1') })
    registry.clearForPrincipalChange()
    expect(registry.snapshot()).toEqual([])
    expect(registry.reconnectFrames()).toEqual([])
  })
})

describe('ClientSubscriptionRegistry topics (ADR 7 Amendment 2 D20)', () => {
  const sample = (n: number) => ({ online: n % 2 === 0, since: null })

  it('reference-counts holders per key: the first acquires, the last releases', () => {
    const registry = new ClientSubscriptionRegistry(false)
    const a = {}
    const b = {}
    expect(registry.acquireTopic('machine.condition', 'm1', a).fresh).toBe(true)
    expect(registry.acquireTopic('machine.condition', 'm1', b).fresh).toBe(false)
    expect(registry.releaseTopic('machine.condition', 'm1', a)).toBe(false)
    expect(registry.releaseTopic('machine.condition', 'm1', b)).toBe(true)
    expect(registry.topic('machine.condition', 'm1')).toBeUndefined()
  })

  it('needs a snapshot first, then applies only newer positions of the same epoch', () => {
    const registry = new ClientSubscriptionRegistry(false)
    const { entry } = registry.acquireTopic('machine.condition', 'm1', {})
    expect(entry.state).toEqual({ status: 'pending' })
    expect(registry.applyTopicUpdate(entry, { epoch: 'e1', seq: 1 }, sample(1))).toBe(false)
    registry.applyTopicSnapshot(entry, { epoch: 'e1', seq: 1 }, sample(1))
    expect(registry.applyTopicUpdate(entry, { epoch: 'e1', seq: 1 }, sample(2))).toBe(false)
    expect(registry.applyTopicUpdate(entry, { epoch: 'e2', seq: 5 }, sample(2))).toBe(false)
    expect(registry.applyTopicUpdate(entry, { epoch: 'e1', seq: 2 }, sample(2))).toBe(true)
    expect(entry.state).toMatchObject({ status: 'value', value: sample(2) })
  })

  it('goes unknown on a declared connection loss, keeping the last value', () => {
    const registry = new ClientSubscriptionRegistry(false)
    const { entry } = registry.acquireTopic('machine.condition', 'm1', {})
    registry.applyTopicSnapshot(entry, { epoch: 'e1', seq: 0 }, sample(0))
    expect(registry.markTopicsUnknown(42)).toEqual([entry])
    expect(entry.state).toEqual({ status: 'unknown', last: sample(0), since: 42 })
    // Event kinds have no value to lose.
    registry.acquireTopic('account.events', 'u1', {})
    expect(registry.markTopicsUnknown(43)).toEqual([])
  })

  it('re-asks every held key after a reconnect, and lists what one holder holds', () => {
    const registry = new ClientSubscriptionRegistry(false)
    const holder = {}
    registry.acquireTopic('machine.metrics', 'm1', holder)
    registry.acquireTopic('machine.metrics', 'm2', holder)
    registry.acquireTopic('machine.condition', 'm1', {})
    expect(registry.topicReconnectFrames()).toEqual([
      { type: 'topicSubscribe', key: 'machine.metrics:m1' },
      { type: 'topicSubscribe', key: 'machine.metrics:m2' },
      { type: 'topicSubscribe', key: 'machine.condition:m1' },
    ])
    expect(registry.topicIdsHeldBy('machine.metrics', holder)).toEqual(['m1', 'm2'])
    registry.clearForPrincipalChange()
    expect(registry.topicReconnectFrames()).toEqual([])
  })
})
