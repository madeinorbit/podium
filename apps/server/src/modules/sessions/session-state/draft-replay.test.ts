import { asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import type { LiveServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { OPERATOR } from '../../../test-support/capabilities'
import { type SessionStatePorts, SessionStateService } from './service'

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
      return { owner: firstAdminMemberId(), grants: [] }
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
        { userId: firstAdminMemberId(), capability: OPERATOR, humanDirect: true },
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

function runtimeDraftWorld() {
  const sessionId = asSessionId('runtime-draft')
  const session = {
    sessionId,
    machineId: 'machine',
    lastActiveAt: '9999-01-01T00:00:00.000Z',
    hasBoundDriver: true,
  }
  const runtimeDraft = vi.fn(async () => ({ result: { text: 'from get' } }))
  const runtimeSnapshot = vi.fn(async () => ({ result: { snapshot: { draft: 'from snapshot' } } }))
  const toMachine = vi.fn()
  const broadcastToClients = vi.fn(),
    deliverToClient = vi.fn(),
    setDraftDoc = vi.fn()
  const state = new SessionStateService({
    store: { sessions: { setDraftDoc } },
    now: Date.now,
    getSession: () => session,
    sessionIds: () => [sessionId],
    clients: () => [],
    sessionOwner: vi.fn(),
    persistSession: vi.fn(),
    writeSession: vi.fn(),
    mutateSession: vi.fn(),
    broadcastSessions: vi.fn(),
    broadcastToClients,
    deliverToClient,
    toMachine,
    runtimeDraft,
    runtimeSnapshot,
    onArchived: vi.fn(),
  } as unknown as SessionStatePorts)
  state.setDraftSyncEnabled(true)
  return {
    state,
    sessionId,
    session,
    runtimeDraft,
    runtimeSnapshot,
    toMachine,
    broadcastToClients,
    deliverToClient,
    setDraftDoc,
  }
}

describe('draft acknowledgements', () => {
  it.each([
    'already confirmed',
    '',
  ])('acknowledges an unchanged %j offer only to its sender', async (text) => {
    const w = runtimeDraftWorld()
    w.state.setDraftSyncEnabled(false)
    try {
      await w.state.setDraft({ sessionId: w.sessionId, text })
      const rev = w.state.draftRevision(w.sessionId) ?? 0
      w.broadcastToClients.mockClear()
      w.deliverToClient.mockClear()
      w.setDraftDoc.mockClear()
      await w.state.handleDraftEdit(
        { type: 'draftEdit', sessionId: w.sessionId, baseRev: rev, text },
        'retrying-device',
      )
      expect(w.deliverToClient).toHaveBeenCalledExactlyOnceWith(
        'retrying-device',
        expect.objectContaining({
          type: 'sessionDraftChanged',
          sessionId: w.sessionId,
          text,
          rev,
        }),
      )
      expect(w.broadcastToClients).not.toHaveBeenCalled()
      expect(w.setDraftDoc).not.toHaveBeenCalled()
      expect(w.state.draftRevision(w.sessionId) ?? 0).toBe(rev)
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })
})

describe('runtime draft bootstrap', () => {
  it('consumes snapshots, including an empty draft, without polling', async () => {
    const w = runtimeDraftWorld()
    try {
      await w.state.initializeRuntimeDraft(w.sessionId, w.session.machineId as never)
      expect(w.state.draftText(w.sessionId)).toBe('from snapshot')
      w.runtimeSnapshot.mockResolvedValue({ result: { snapshot: { draft: '' } } })
      await w.state.initializeRuntimeDraft(w.sessionId, w.session.machineId as never)
      expect(w.state.draftText(w.sessionId)).toBe('')
      expect(w.runtimeDraft).not.toHaveBeenCalled()
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })

  it('uses draft.get when a snapshot has no composer value', async () => {
    const w = runtimeDraftWorld()
    w.runtimeSnapshot.mockResolvedValue({ result: { snapshot: {} } } as never)
    try {
      await w.state.initializeRuntimeDraft(w.sessionId, w.session.machineId as never)
      expect(w.state.draftText(w.sessionId)).toBe('from get')
      expect(w.runtimeDraft).toHaveBeenCalledWith(
        { sessionId: w.sessionId, operation: { verb: 'get' } },
        w.session.machineId,
      )
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })

  it('does not overwrite an edit made while the snapshot is in flight', async () => {
    const w = runtimeDraftWorld()
    let resolve!: (value: { result: { snapshot: { draft: string } } }) => void
    w.runtimeSnapshot.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    try {
      const pending = w.state.initializeRuntimeDraft(w.sessionId, w.session.machineId as never)
      await w.state.setDraft({ sessionId: w.sessionId, text: 'new local edit' })
      resolve({ result: { snapshot: { draft: 'old remote text' } } })
      await pending
      expect(w.state.draftText(w.sessionId)).toBe('new local edit')
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })

  it('catches up an offline chat edit through draft.set', async () => {
    const w = runtimeDraftWorld()
    w.session.lastActiveAt = '2000-01-01T00:00:00.000Z'
    try {
      await w.state.setDraft({ sessionId: w.sessionId, text: 'offline edit' })
      await w.state.initializeRuntimeDraft(w.sessionId, w.session.machineId as never)
      expect(w.runtimeDraft).toHaveBeenCalledWith(
        { sessionId: w.sessionId, operation: { verb: 'set', text: 'offline edit' } },
        w.session.machineId,
      )
      expect(w.toMachine).not.toHaveBeenCalled()
      expect(w.runtimeSnapshot).not.toHaveBeenCalled()
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })
})
