import { asSessionId, type MessageRecordWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createSendsFixture } from './model-test-support'

describe('shared wake request ordering', () => {
  it('uses server message time through dispatch and drops failed outcomes', async () => {
    const listeners = new Set<() => void>()
    const createdAt = '2026-11-13T06:00:10.000Z'
    let records: MessageRecordWire[] = []
    const fixture = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
      records: {
        getSnapshot: () => records,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      createDeliveryId: () => 'wake-message',
      deliver: async () => ({ state: 'queued' }),
      clock: {
        now: () => Date.parse(createdAt) + 120_000,
        setTimeout: () => 0,
        clearTimeout: () => {},
      },
    })
    const publish = (status: MessageRecordWire['status'], timestamp = createdAt) => {
      records = [
        {
          id: 'wake-message',
          sessionId: asSessionId('s1'),
          senderUserId: 'user',
          body: 'Continue',
          createdAt: timestamp,
          status,
        },
      ]
      for (const listener of listeners) listener()
    }
    fixture.start()
    try {
      await fixture.submit({ text: 'Continue' })
      // A phone clock two minutes ahead cannot keep an exited process waking.
      expect(fixture.model.wakeRequestedAt).toBeUndefined()
      for (const status of [
        'stored',
        'dispatched',
        'reached-machine',
        'accepted',
        'typing',
      ] as const) {
        publish(status)
        expect(fixture.model.wakeRequestedAt).toBe(Date.parse(createdAt))
      }
      publish('failed')
      expect(fixture.model.wakeRequestedAt).toBeUndefined()
      publish('stored', 'invalid')
      expect(fixture.model.wakeRequestedAt).toBeUndefined()
    } finally {
      fixture.dispose()
    }
  })
})
