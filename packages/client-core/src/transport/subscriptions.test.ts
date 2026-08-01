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
