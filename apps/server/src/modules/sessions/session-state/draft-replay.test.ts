import {
  asSessionId,
  asUserId,
  asWorkspaceId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
  type WorkspaceId,
} from '@podium/model'
import type { LiveServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../../../self-hosted-workspace'
import { OPERATOR } from '../../../test-support/capabilities'
import { type SessionStatePorts, type SessionStatePrincipal, SessionStateService } from './service'

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
    // Only the REPLAY's owner read is held: the edit checks the session's
    // owner too (POD-7561), and that check must not wait on the replay's.
    let hold: Promise<void> | undefined
    const sessionOwner = vi.fn(async () => {
      const held = hold
      hold = undefined
      if (held) await held
      return { owner: firstAdminMemberId(), grants: [] }
    })
    const state = new SessionStateService({
      store: {
        workspaceId: SELF_HOSTED_WORKSPACE_ID,
        sessions: {
          setDraftDoc: vi.fn(),
          draftDocOf: async () => undefined,
          loadDraftDocs: async () => ({}),
        },
      } as unknown as SessionStatePorts['store'],
      now: Date.now,
      getSession: () => undefined,
      liveWriter: undefined as never,
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
      const ownerReads = sessionOwner.mock.calls.length
      hold = authorization
      const replay = state.replayDrafts(
        {
          workspaceId: SELF_HOSTED_WORKSPACE_ID,
          userId: firstAdminMemberId(),
          capability: OPERATOR,
          humanDirect: true,
        },
        send,
      )
      // The replay reads the stored drafts first (POD-6160), then authorizes.
      await vi.waitFor(() => expect(sessionOwner).toHaveBeenCalledTimes(ownerReads + 1))
      expect(received).toEqual([])

      // The real versioned edit broadcasts to this client while replay is paused.
      await state.handleDraftEdit(
        {
          workspaceId: SELF_HOSTED_WORKSPACE_ID,
          userId: firstAdminMemberId(),
          capability: OPERATOR,
          humanDirect: true,
          clientId: 'other-client',
        },
        { type: 'draftEdit', sessionId, baseRev: 1, text },
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

describe('draft replay authorization (POD-7036)', () => {
  it('reads the owners of every stored draft together, not one session at a time', async () => {
    // A client connect replays every stored draft. Each draft's session was
    // checked on its own: for a parked session, a registry miss and a read of
    // its row, ~330 of them per connect on the live server.
    const admin = firstAdminMemberId()
    const ids = ['a', 'b', 'c', 'd', 'e'].map((id) => asSessionId(`parked-${id}`))
    const stored = Object.fromEntries(
      ids.map((id) => [
        id,
        { text: `draft of ${id}`, updatedAt: 't1', rev: 1, origin: 'seed', history: [] },
      ]),
    )
    const primed: SessionId[][] = []
    const durableReads: SessionId[] = []
    const received: LiveServerMessage[] = []
    const state = new SessionStateService({
      store: {
        workspaceId: SELF_HOSTED_WORKSPACE_ID,
        sessions: {
          setDraftDoc: vi.fn(),
          draftDocOf: async () => undefined,
          loadDraftDocs: async () => stored,
        },
      } as unknown as SessionStatePorts['store'],
      now: Date.now,
      getSession: () => undefined,
      liveWriter: undefined as never,
      sessionIds: () => [],
      clients: () => [],
      primeOwnerMemo: async (memo, sessionIds) => {
        primed.push([...sessionIds])
        memo.sessions ??= new Map()
        for (const id of sessionIds) memo.sessions.set(id, { ownerUserId: admin, issueId: null })
      },
      sessionOwner: async ({ sessionId, memo }) => {
        const known = memo?.sessions?.get(sessionId)
        if (known === undefined) durableReads.push(sessionId)
        return { owner: known?.ownerUserId ?? admin }
      },
      persistSession: vi.fn(),
      writeSession: vi.fn(),
      mutateSession: vi.fn(),
      broadcastSessions: vi.fn(),
      broadcastToClients: vi.fn(),
      deliverToClient: vi.fn(),
      toMachine: vi.fn(),
      onArchived: vi.fn(),
    })

    await state.replayDrafts(
      {
        workspaceId: SELF_HOSTED_WORKSPACE_ID,
        userId: admin,
        capability: OPERATOR,
        humanDirect: true,
      },
      (message) => received.push(message),
    )

    expect(received.map((message) => (message as { sessionId?: string }).sessionId).sort()).toEqual(
      [...ids].sort(),
    )
    expect(primed).toEqual([ids])
    expect(durableReads).toEqual([])
  })
})

const OWNER = firstAdminMemberId()
const STRANGER = asUserId('mem_draft_stranger')
const OTHER_WORKSPACE = asWorkspaceId('ws_other')

/** A `/client` connection's session-state principal, as the wiring builds it. */
function principalOf(
  userId: UserId,
  clientId: string,
  workspaceId: WorkspaceId = SELF_HOSTED_WORKSPACE_ID,
): SessionStatePrincipal {
  return { workspaceId, userId, capability: OPERATOR, humanDirect: true, clientId }
}

function draftWorld() {
  const sessionId = asSessionId('draft-ack')
  const session = {
    sessionId,
    machineId: 'machine',
    lastActiveAt: '9999-01-01T00:00:00.000Z',
    hasBoundDriver: true,
  }
  const toMachine = vi.fn()
  const sessionOwner = vi.fn<SessionStatePorts['sessionOwner']>(async () => ({ owner: OWNER }))
  const broadcastToClients = vi.fn(),
    deliverToClient = vi.fn(),
    setDraftDoc = vi.fn()
  const state = new SessionStateService({
    // No stored draft: documents start in this process (POD-6160 reads on use).
    store: {
      workspaceId: SELF_HOSTED_WORKSPACE_ID,
      sessions: { setDraftDoc, draftDocOf: async () => undefined, loadDraftDocs: async () => ({}) },
    },
    now: Date.now,
    getSession: () => session,
    sessionIds: () => [sessionId],
    clients: () => [],
    sessionOwner,
    persistSession: vi.fn(),
    writeSession: vi.fn(),
    mutateSession: vi.fn(),
    broadcastSessions: vi.fn(),
    broadcastToClients,
    deliverToClient,
    toMachine,
    onArchived: vi.fn(),
  } as unknown as SessionStatePorts)
  return {
    state,
    sessionId,
    session,
    sessionOwner,
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
    const w = draftWorld()
    try {
      await w.state.setDraft({ sessionId: w.sessionId, text })
      const rev = (await w.state.draftRevision(w.sessionId)) ?? 0
      w.broadcastToClients.mockClear()
      w.deliverToClient.mockClear()
      w.setDraftDoc.mockClear()
      await w.state.handleDraftEdit(principalOf(OWNER, 'retrying-device'), {
        type: 'draftEdit',
        sessionId: w.sessionId,
        baseRev: rev,
        text,
      })
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
      expect((await w.state.draftRevision(w.sessionId)) ?? 0).toBe(rev)
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })
})

describe('draft access (POD-7561)', () => {
  // A draft is its session's content, and a session is its owner's (design
  // §2.3): only a connection whose person may read the session edits, clears,
  // hears about or is replayed its draft. Refusals answer nothing at all.
  async function seeded() {
    const w = draftWorld()
    await w.state.handleDraftEdit(principalOf(OWNER, 'owner-device'), {
      type: 'draftEdit',
      sessionId: w.sessionId,
      baseRev: 0,
      text: 'unsent text',
    })
    w.broadcastToClients.mockClear()
    w.deliverToClient.mockClear()
    w.setDraftDoc.mockClear()
    return w
  }

  it('broadcasts a server seed without a client only to the session owner’s connections', async () => {
    const w = draftWorld()
    try {
      await w.state.setDraft({ sessionId: w.sessionId, text: 'recovered prompt' })
      expect(w.deliverToClient).not.toHaveBeenCalled()
      expect(w.broadcastToClients).toHaveBeenCalledTimes(1)
      const [message, options] = w.broadcastToClients.mock.calls[0]!
      expect(message).toMatchObject({
        type: 'sessionDraftChanged',
        sessionId: w.sessionId,
        text: 'recovered prompt',
        origin: 'seed',
        rev: 1,
      })
      const to = (options as { to: (conn: unknown) => boolean }).to
      for (const id of ['owner-desktop', 'owner-phone']) {
        expect(to({ id, principal: { user: OWNER }, workspaceId: SELF_HOSTED_WORKSPACE_ID })).toBe(
          true,
        )
      }
      expect(to({ principal: { user: STRANGER }, workspaceId: SELF_HOSTED_WORKSPACE_ID })).toBe(
        false,
      )
      expect(to({ principal: { user: OWNER }, workspaceId: OTHER_WORKSPACE })).toBe(false)
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })

  it.each([
    undefined,
    { owner: null },
  ])('gives a server seed no audience when its owner resolves to %j', async (owner) => {
    const w = draftWorld()
    w.sessionOwner.mockResolvedValue(owner)
    try {
      await w.state.setDraft({ sessionId: w.sessionId, text: 'unclaimed prompt' })
      expect(await w.state.draftText(w.sessionId)).toBe('unclaimed prompt')
      expect(w.deliverToClient).not.toHaveBeenCalled()
      if (!owner) expect(w.broadcastToClients).not.toHaveBeenCalled()
      for (const [, options] of w.broadcastToClients.mock.calls) {
        const to = (options as { to: (conn: unknown) => boolean }).to
        for (const user of [OWNER, STRANGER]) {
          expect(to({ principal: { user }, workspaceId: SELF_HOSTED_WORKSPACE_ID })).toBe(false)
        }
      }
      const received = vi.fn()
      await w.state.replayDrafts(principalOf(OWNER, 'owner-device'), received)
      expect(received).not.toHaveBeenCalled()
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })

  it.each([
    ['another member', principalOf(STRANGER, 'stranger')],
    ['the owner id from another workspace', principalOf(OWNER, 'foreign', OTHER_WORKSPACE)],
  ])('refuses %s an edit, a clear and a stale probe without a reply', async (_who, principal) => {
    const w = await seeded()
    try {
      for (const edit of [
        { baseRev: 1, text: 'overwritten' },
        { baseRev: 1, text: '' },
        // Stale: the arbitration would answer the sender with the current text.
        { baseRev: 0, text: 'probe' },
      ]) {
        await w.state.handleDraftEdit(principal, {
          type: 'draftEdit',
          sessionId: w.sessionId,
          ...edit,
        })
      }
      expect(await w.state.draftText(w.sessionId)).toBe('unsent text')
      expect(await w.state.draftRevision(w.sessionId)).toBe(1)
      expect(w.deliverToClient).not.toHaveBeenCalled()
      expect(w.broadcastToClients).not.toHaveBeenCalled()
      expect(w.setDraftDoc).not.toHaveBeenCalled()
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })

  it('lets the owner edit and clear, and tells only the readers of the session', async () => {
    const w = await seeded()
    try {
      await w.state.handleDraftEdit(principalOf(OWNER, 'owner-device'), {
        type: 'draftEdit',
        sessionId: w.sessionId,
        baseRev: 1,
        text: 'sent soon',
      })
      await w.state.handleDraftEdit(principalOf(OWNER, 'owner-device'), {
        type: 'draftEdit',
        sessionId: w.sessionId,
        baseRev: 2,
        text: '',
      })
      expect(await w.state.draftRevision(w.sessionId)).toBe(3)
      expect(await w.state.draftText(w.sessionId)).toBe('')
      expect(w.broadcastToClients).toHaveBeenCalledTimes(2)
      for (const [message, options] of w.broadcastToClients.mock.calls) {
        expect(message).toMatchObject({ type: 'sessionDraftChanged', sessionId: w.sessionId })
        const to = (options as { to: (conn: unknown) => boolean }).to
        const conn = (user: UserId, workspaceId: WorkspaceId = SELF_HOSTED_WORKSPACE_ID) => ({
          principal: { user },
          workspaceId,
        })
        expect(to(conn(OWNER))).toBe(true)
        expect(to(conn(STRANGER))).toBe(false)
        expect(to(conn(OWNER, OTHER_WORKSPACE))).toBe(false)
      }
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })

  it.each([
    ['another member', principalOf(STRANGER, 'stranger'), []],
    ['the owner id from another workspace', principalOf(OWNER, 'foreign', OTHER_WORKSPACE), []],
    ['the owner', principalOf(OWNER, 'owner-device-2'), ['unsent text']],
  ])('replays the draft to %s: %j', async (_who, principal, expected) => {
    const w = await seeded()
    try {
      const received: LiveServerMessage[] = []
      await w.state.replayDrafts(principal, (message) => received.push(message))
      expect(received.map((m) => (m as { text?: string }).text)).toEqual(expected)
    } finally {
      w.state.removeSession(w.sessionId)
    }
  })
})
