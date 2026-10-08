import { DraftStore } from '@podium/client-core/conversation'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import { MobileConversation } from './mobile-conversation'

it('retains history for any mounted reader and drops its demand on close', () => {
  const item = (id: string): TranscriptItem => ({ id, cursor: id, role: 'assistant', text: id })
  const items = ['a', 'b', 'c'].map(item)
  const drafts = new DraftStore({
    storage: { get: () => null, set: () => {} },
    hub: {
      on: () => () => {},
      sendDraftEdit: () => {},
      connectionHealth: () => ({ status: 'ok' }),
    } as never,
  })
  const conversation = new MobileConversation({
    sessionId: asSessionId('phone-readers'),
    drafts,
    sends: { createDeliveryId: () => 'unused', deliver: async () => ({ state: 'sent' }) },
    transcript: {
      initialLimit: 1,
      source: { read: async () => ({ items, hasMore: false }), subscribe: () => () => {} },
      cache: { read: () => ({ items, savedAt: 1 }), write: () => {} },
    },
  })
  const closeFollowing = conversation.addReader(() => false)
  const closeReading = conversation.addReader(() => true)
  try {
    conversation.transcript.merge([item('d')])
    expect([...conversation.transcript.ids]).toEqual(['a', 'b', 'c', 'd'])
    closeReading()
    conversation.transcript.merge([item('e')])
    expect([...conversation.transcript.ids]).toEqual(['d', 'e'])
  } finally {
    closeFollowing()
    conversation.dispose()
    drafts.dispose()
  }
})
