import { asSessionId, asUserId, SOLE_USER_ID } from '@podium/model'
import type { LiveServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { OPERATOR } from '../../../test-support/capabilities'
import { SessionStateService, type SessionStatePorts } from './service'

describe('draft replay ordering', () => {
  it.each([
    'newer text',
    '',
  ])('keeps the live revision when an edit to %j races authorization', async (text) => {
    const received: LiveServerMessage[] = []
    const send = (message: LiveServerMessage) => received.push(message)
    let release!: () => void
    const authorization = new Promise<void>((resolve) => {
      release = resolve
    })
    const sessionOwner = vi.fn(async () => {
      await authorization
      return { owner: asUserId(SOLE_USER_ID), grants: [] }
    })
    const state = new SessionStateService({
      store: { sessions: { setDraftDoc: vi.fn() } } as unknown as SessionStatePorts['store'],
      now: Date.now,
      getSession: () => undefined,
      sessionIds: () => [],
      clients: () => [],
      sessionOwner,
      persistSession: vi.fn(),
      writeSession: vi.fn(),
      mutateSession: vi.fn(),
      broadcastSessions: vi.fn(),
      broadcastToClients: send,
      deliverToClient: vi.fn(),
      toMachine: vi.fn(),
      onArchived: vi.fn(),
    })
    const sessionId = asSessionId('replaying-session')
    try {
      await state.setDraft({ sessionId, text: 'older text' })
      received.length = 0
      const replay = state.replayDrafts(
        { userId: asUserId(SOLE_USER_ID), capability: OPERATOR, humanDirect: true },
        send,
      )
      expect(sessionOwner).toHaveBeenCalledOnce()
      expect(received).toEqual([])

      // The real versioned edit broadcasts to this client while replay is paused.
      await state.handleDraftEdit(
        { type: 'draftEdit', sessionId, baseRev: 1, text },
        'other-client',
      )
      expect(received).toEqual([
        expect.objectContaining({ type: 'sessionDraftChanged', sessionId, rev: 2, text }),
      ])
      release()
      await replay

      const drafts = received.filter(
        (message) => message.type === 'sessionDraftChanged' && message.sessionId === sessionId,
      )
      expect(drafts.at(-1)).toMatchObject({ rev: 2, text })
    } finally {
      release()
      state.removeSession(sessionId)
    }
  })
})
