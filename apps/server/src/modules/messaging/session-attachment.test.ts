/**
 * Direct session attachment through the Telegram bridge (POD-6212), driven at
 * the bridge's own boundary: inbound chat messages in, adapter sends and port
 * calls out. The port and the attachment store are fakes; the store's SQL is
 * `store/messaging-session-attachments.test.ts`'s, the port's gates are
 * `direct-session-port.test.ts`'s.
 */

import {
  type AgentRuntimeState,
  asIssueId,
  asSessionId,
  asThreadId,
  asUserId,
  firstAdminMemberId,
  type SessionId,
  type TelegramChatBinding,
  type TranscriptItem,
  type UserId,
} from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { MessagingSessionAttachmentRow } from '../../store/messaging-session-attachments'
import { EventBus } from '../bus'
import { MessagingService, type MessagingDeps } from './service'
import type {
  AttachableSession,
  DirectSessionPort,
  SessionAttachmentStore,
} from './session-attachment'
import type { ChannelAdapter, InboundChatMessage } from './types'

const USER = firstAdminMemberId()
const OTHER = asUserId('usr-other')
const WORKER = asSessionId('aaaaaaaa-1111-4111-8111-111111111111')
const PARKED = asSessionId('bbbbbbbb-2222-4222-8222-222222222222')
const ENDED = asSessionId('cccccccc-3333-4333-8333-333333333333')
const FOREIGN = asSessionId('dddddddd-4444-4444-8444-444444444444')
const SUPER = asSessionId('eeeeeeee-5555-4555-8555-555555555555')

const binding = (chatId: string, userId: UserId = USER): TelegramChatBinding => ({
  userId,
  chatId,
  boundAt: '2026-10-17T00:00:00.000Z',
  boundBy: { actor: { kind: 'user', id: userId }, onBehalfOf: userId },
})

const session = (over: Partial<AttachableSession> & Pick<AttachableSession, 'sessionId'>): AttachableSession => ({
  ownerUserId: USER,
  label: 'worker',
  status: 'live',
  reconnecting: false,
  archived: false,
  headless: false,
  agentKind: 'claude-code',
  resumable: true,
  phase: 'idle',
  lastActiveAt: '2026-10-17T00:00:00.000Z',
  ...over,
})

const state = (phase: AgentRuntimeState['phase']): AgentRuntimeState => ({
  phase,
  since: '2026-10-17T00:00:00.000Z',
  nativeSubagentCount: 0,
})

function memoryStore(): SessionAttachmentStore & { rows: Map<string, MessagingSessionAttachmentRow> } {
  const rows = new Map<string, MessagingSessionAttachmentRow>()
  const key = (chatId: string, threadRef: string) => `${chatId}\0${threadRef}`
  return {
    rows,
    get: async (chatId, threadRef) => rows.get(key(chatId, threadRef)),
    listForSession: async (sessionId) => [...rows.values()].filter((r) => r.sessionId === sessionId),
    upsert: async (row) => {
      rows.set(key(row.chatId, row.threadRef), { ...row })
    },
    remove: async (chatId, threadRef) => {
      rows.delete(key(chatId, threadRef))
    },
    markRelayed: async (chatId, threadRef, sessionId, itemId) => {
      const row = rows.get(key(chatId, threadRef))
      if (row && row.sessionId === sessionId) row.relayedItemId = itemId
    },
  }
}

interface Harness {
  bus: EventBus
  store: ReturnType<typeof memoryStore>
  sessions: Map<SessionId, AttachableSession>
  transcripts: Map<SessionId, TranscriptItem[]>
  port: { [K in keyof DirectSessionPort]: ReturnType<typeof vi.fn> }
  sent: Array<{ chatId: string; text: string; threadRef?: string; buttons?: unknown }>
  sendTurn: ReturnType<typeof vi.fn>
  interruptTurn: ReturnType<typeof vi.fn>
  restartThread: ReturnType<typeof vi.fn>
  answerCallback: ReturnType<typeof vi.fn>
  inbound(text: string, opts?: { threadRef?: string; callback?: string }): Promise<void>
  restart(): Promise<Harness>
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))
}

async function makeHarness(
  opts: {
    bindings?: TelegramChatBinding[]
    store?: ReturnType<typeof memoryStore>
    sessions?: Map<SessionId, AttachableSession>
    transcripts?: Map<SessionId, TranscriptItem[]>
    topics?: MessagingDeps['topics']
    sendOutcome?: { ok: boolean; queued?: boolean; position?: number; reason?: string }
  } = {},
): Promise<Harness> {
  const bus = new EventBus()
  const store = opts.store ?? memoryStore()
  const sessions =
    opts.sessions ??
    new Map<SessionId, AttachableSession>([
      [WORKER, session({ sessionId: WORKER, ref: 'POD-12-A', label: 'Fix the lease' })],
      [PARKED, session({ sessionId: PARKED, label: 'parked one', status: 'hibernated' })],
      [ENDED, session({ sessionId: ENDED, label: 'ended one', status: 'exited', resumable: false })],
      [FOREIGN, session({ sessionId: FOREIGN, ownerUserId: OTHER, label: 'not yours' })],
      [SUPER, session({ sessionId: SUPER, headless: true, label: 'superagent' })],
    ])
  const transcripts = opts.transcripts ?? new Map<SessionId, TranscriptItem[]>()
  const sent: Harness['sent'] = []
  const answerCallback = vi.fn(async () => {})
  let onMessage: ((msg: InboundChatMessage) => void) | undefined
  const adapter: ChannelAdapter = {
    channel: 'telegram',
    start: (cb) => {
      onMessage = cb
    },
    stop: () => {},
    send: async (target, text, sendOpts) => {
      sent.push({
        chatId: target.chatId,
        text,
        ...(target.threadRef ? { threadRef: target.threadRef } : {}),
        ...(sendOpts?.replyMarkup ? { buttons: sendOpts.replyMarkup.inlineKeyboard } : {}),
      })
    },
    answerCallback,
    sendTyping: () => {},
  }
  const port = {
    resolve: vi.fn(async (_userId: UserId, identifier: string) => {
      const found = [...sessions.values()].find(
        (s) => s.sessionId === identifier || s.sessionId.startsWith(identifier) || s.ref === identifier,
      )
      return found ? { kind: 'session' as const, session: found } : { kind: 'absent' as const }
    }),
    describe: vi.fn(async (_userId: UserId, sessionId: SessionId) => sessions.get(sessionId)),
    listRunning: vi.fn(async () =>
      [...sessions.values()].filter((s) => ['live', 'starting'].includes(s.status)),
    ),
    send: vi.fn(async () => opts.sendOutcome ?? { ok: true }),
    interrupt: vi.fn(async () => ({ ok: true })),
    wake: vi.fn(async () => ({ ok: true })),
    readTail: vi.fn(async (_userId: UserId, sessionId: SessionId) => transcripts.get(sessionId) ?? []),
  }
  const sendTurn = vi.fn(async () => ({ threadId: asThreadId('global'), podiumSessionId: asSessionId('ps1') }))
  const interruptTurn = vi.fn()
  const restartThread = vi.fn()
  const service = new MessagingService({
    bus,
    routing: { chatIdForUser: async () => '42' },
    telegramBotToken: async () => 'tok',
    superagent: {
      sendTurn: sendTurn as never,
      interruptTurn: interruptTurn as never,
      restartThread: restartThread as never,
      startBtwTurn: vi.fn() as never,
      ensureConciergeThread: vi.fn() as never,
    },
    ...(opts.topics ? { topics: opts.topics } : {}),
    telegramBindings: { list: async () => opts.bindings ?? [binding('42')] },
    createTelegram: () => adapter,
    registerTelegramCommands: async () => {},
    directSessions: port as unknown as DirectSessionPort,
    sessionAttachments: store,
    sessionRelayRetryMs: 0,
  })
  await service.configure()
  const harness: Harness = {
    bus,
    store,
    sessions,
    transcripts,
    port,
    sent,
    sendTurn,
    interruptTurn,
    restartThread,
    answerCallback,
    inbound: async (text, inboundOpts) => {
      onMessage?.({
        source: {
          channel: 'telegram',
          chatId: '42',
          ...(inboundOpts?.threadRef ? { threadRef: inboundOpts.threadRef } : {}),
        },
        text,
        ...(inboundOpts?.callback ? { callback: { id: 'cb', data: inboundOpts.callback } } : {}),
      })
      await flush()
    },
    // A fresh process over the same durable rows.
    restart: async () => await makeHarness({ ...opts, store, sessions, transcripts }),
  }
  return harness
}

const texts = (h: Harness) => h.sent.map((s) => s.text)

describe('Telegram direct session attachment', () => {
  it('lists only the user’s own attachable running sessions, each with an attach button', async () => {
    const h = await makeHarness()
    await h.inbound('/sessions')
    expect(h.sent).toHaveLength(1)
    const [list] = h.sent
    expect(list?.text).toContain('POD-12-A Fix the lease (idle)')
    expect(list?.text).not.toContain('not yours')
    expect(list?.text).not.toContain('superagent')
    expect(list?.text).not.toContain('parked one')
    expect(list?.buttons).toEqual([[{ label: 'POD-12-A Fix the lease', data: `s:${WORKER}` }]])
  })

  it('/attach with no argument shows the session list rather than guessing one', async () => {
    const h = await makeHarness()
    await h.inbound('/attach')
    expect(h.store.rows.size).toBe(0)
    expect(texts(h)[0]).toMatch(/^Your running sessions:/)
  })

  it('attaches the main chat by ref and sends plain messages to that session, not the superagent', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A')
    expect(h.port.resolve).toHaveBeenCalledWith(USER, 'POD-12-A')
    expect([...h.store.rows.values()]).toEqual([
      expect.objectContaining({ chatId: '42', threadRef: '', userId: USER, sessionId: WORKER }),
    ])
    expect(texts(h)[0]).toContain('Attached to POD-12-A Fix the lease (idle)')
    expect(texts(h)[0]).toContain('/detach returns this chat to the superagent')

    await h.inbound('run the tests')
    expect(h.port.send).toHaveBeenCalledWith(USER, WORKER, 'run the tests')
    expect(h.sendTurn).not.toHaveBeenCalled()
  })

  it('says a busy session queued the message', async () => {
    const h = await makeHarness({ sendOutcome: { ok: true, queued: true, position: 2 } })
    await h.inbound('/attach POD-12-A')
    h.sent.length = 0
    await h.inbound('next thing')
    expect(texts(h)).toEqual([
      '⏳ Queued (#2). POD-12-A Fix the lease is busy; it gets this when the current turn ends.',
    ])
  })

  it('keeps each topic and the main chat apart', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A', { threadRef: '77' })
    await h.inbound('to the topic', { threadRef: '77' })
    await h.inbound('to the main chat')

    expect(h.port.send).toHaveBeenCalledTimes(1)
    expect(h.port.send).toHaveBeenCalledWith(USER, WORKER, 'to the topic')
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sendTurn.mock.calls[0]![0]).toMatchObject({ threadId: 'global' })
  })

  it('attaches from an /sessions button in the conversation the button was pressed in', async () => {
    const h = await makeHarness()
    await h.inbound('', { threadRef: '5', callback: `s:${WORKER}` })
    expect(h.answerCallback).toHaveBeenCalledWith('cb', undefined)
    expect(await h.store.get('42', '5')).toMatchObject({ sessionId: WORKER })
    expect(await h.store.get('42', '')).toBeUndefined()
  })

  it('refuses another user’s session with the same answer as an unknown one', async () => {
    const h = await makeHarness()
    await h.inbound(`/attach ${FOREIGN}`)
    await h.inbound('/attach nothing-like-it')
    expect(h.store.rows.size).toBe(0)
    expect(texts(h)).toEqual([
      `⚠️ No session of yours matches “${FOREIGN}”. /sessions lists them.`,
      '⚠️ No session of yours matches “nothing-like-it”. /sessions lists them.',
    ])
  })

  it('refuses the superagent’s own session and an ended one', async () => {
    const h = await makeHarness()
    await h.inbound(`/attach ${SUPER}`)
    await h.inbound(`/attach ${ENDED}`)
    expect(h.store.rows.size).toBe(0)
    expect(texts(h)[0]).toMatch(/superagent’s own session/)
    expect(texts(h)[1]).toMatch(/has ended and cannot be resumed/)
  })

  it('never wakes a parked session for a message; /wake is the explicit way', async () => {
    const h = await makeHarness()
    await h.inbound(`/attach ${PARKED}`)
    expect(texts(h)[0]).toContain('It is parked: messages will not wake it. /wake resumes it.')
    h.sent.length = 0

    await h.inbound('are you there?')
    expect(h.port.send).not.toHaveBeenCalled()
    expect(h.port.wake).not.toHaveBeenCalled()
    expect(h.sendTurn).not.toHaveBeenCalled()
    expect(texts(h)).toEqual([
      '⏸ parked one is parked, so this was not sent. /wake resumes it; then send again.',
    ])

    await h.inbound('/wake')
    expect(h.port.wake).toHaveBeenCalledWith(USER, PARKED)
  })

  it('does not fall back to anything when the attached session is gone', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A')
    h.sessions.delete(WORKER)
    h.sent.length = 0

    await h.inbound('hello?')
    expect(h.port.send).not.toHaveBeenCalled()
    expect(h.sendTurn).not.toHaveBeenCalled()
    expect(texts(h)).toEqual([
      '⚠️ The attached session is no longer available, so this was not sent. /detach returns this chat to the superagent.',
    ])
  })

  it('a session that changed owner stops taking this user’s messages', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A')
    h.sessions.set(WORKER, { ...h.sessions.get(WORKER)!, ownerUserId: OTHER })
    await h.inbound('hello?')
    expect(h.port.send).not.toHaveBeenCalled()
  })

  it('/detach returns the main chat to the global superagent', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A')
    await h.inbound('/detach')
    expect(h.store.rows.size).toBe(0)
    expect(texts(h).at(-1)).toBe('Detached from POD-12-A Fix the lease. This chat talks to the superagent again.')

    await h.inbound('back to you')
    expect(h.port.send).not.toHaveBeenCalled()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sendTurn.mock.calls[0]![0]).toMatchObject({ threadId: 'global' })
  })

  it('a detached issue topic goes back to its issue agent', async () => {
    const topics: NonNullable<MessagingDeps['topics']> = {
      listForChat: async () => [],
      getByIssue: async () => undefined,
      getByThreadRef: async (_chatId, threadRef) =>
        threadRef === '77'
          ? {
              issueId: asIssueId('iss_i1'),
              chatId: '42',
              threadRef: '77',
              superagentThreadId: asThreadId('btw_issue'),
              updatedAt: '2026-10-17T00:00:00.000Z',
            }
          : undefined,
      upsert: async () => {},
    }
    const h = await makeHarness({ topics })
    await h.inbound('/attach POD-12-A', { threadRef: '77' })
    await h.inbound('/detach', { threadRef: '77' })
    expect(texts(h).at(-1)).toContain('talks to this topic’s issue agent again')

    await h.inbound('issue question', { threadRef: '77' })
    expect(h.sendTurn.mock.calls[0]![0]).toMatchObject({ threadId: 'btw_issue' })
  })

  it('/status names the attached session, and the default route otherwise', async () => {
    const h = await makeHarness()
    await h.inbound('/status')
    await h.inbound('/attach POD-12-A')
    await h.inbound('/status')
    expect(texts(h)[0]).toBe('This chat talks to the superagent. /sessions to attach one of your sessions.')
    expect(texts(h).at(-1)).toBe(
      'This chat is attached to POD-12-A Fix the lease (idle). /detach returns it to the superagent.',
    )
  })

  it('/stop interrupts the attached session; /new does not restart the superagent', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A')
    await h.inbound('/stop')
    await h.inbound('/new')
    expect(h.port.interrupt).toHaveBeenCalledWith(USER, WORKER)
    expect(h.interruptTurn).not.toHaveBeenCalled()
    expect(h.restartThread).not.toHaveBeenCalled()
    expect(texts(h).at(-1)).toMatch(/\/detach first/)
  })

  it('relays the reply a turn ends with, once, and never an older one', async () => {
    const transcripts = new Map<SessionId, TranscriptItem[]>([
      [WORKER, [{ id: 'old', role: 'assistant', text: 'an answer from before' }]],
    ])
    const h = await makeHarness({ transcripts })
    await h.inbound('/attach POD-12-A')
    // The attach recap shows recent history; it is not a relayed reply.
    expect(texts(h)[1]).toContain('Agent: an answer from before')
    h.sent.length = 0

    // A turn that produced nothing new relays nothing.
    h.bus.emit('session.stateChanged', { sessionId: WORKER, prev: state('working'), next: state('idle') })
    await flush()
    expect(h.sent).toEqual([])

    transcripts.set(WORKER, [
      { id: 'old', role: 'assistant', text: 'an answer from before' },
      { id: 'u1', role: 'user', text: 'run the tests' },
      { id: 'narration', role: 'assistant', text: 'Running them now.' },
      { id: 'call', role: 'assistant', text: '', toolName: 'Bash' },
      { id: 'final', role: 'assistant', text: 'All 12 tests pass.' },
    ])
    h.bus.emit('session.stateChanged', { sessionId: WORKER, prev: state('working'), next: state('idle') })
    await flush()
    h.bus.emit('session.stateChanged', { sessionId: WORKER, prev: state('working'), next: state('idle') })
    await flush()
    expect(h.sent).toEqual([{ chatId: '42', text: 'All 12 tests pass.' }])
    expect((await h.store.get('42', ''))?.relayedItemId).toBe('final')
  })

  it('re-reads once when the turn ends before its last line reached the transcript', async () => {
    const transcripts = new Map<SessionId, TranscriptItem[]>()
    const h = await makeHarness({ transcripts })
    await h.inbound('/attach POD-12-A')
    h.sent.length = 0
    h.port.readTail.mockImplementationOnce(async () => [])
    transcripts.set(WORKER, [{ id: 'late', role: 'assistant', text: 'Done.' }])
    h.bus.emit('session.stateChanged', { sessionId: WORKER, prev: state('working'), next: state('idle') })
    await flush()
    expect(texts(h)).toEqual(['Done.'])
  })

  it('relays into every conversation attached to the session, topics included', async () => {
    const transcripts = new Map<SessionId, TranscriptItem[]>()
    const h = await makeHarness({ transcripts })
    await h.inbound('/attach POD-12-A')
    await h.inbound('/attach POD-12-A', { threadRef: '77' })
    h.sent.length = 0
    transcripts.set(WORKER, [{ id: 'r1', role: 'assistant', text: 'Reply.' }])
    h.bus.emit('session.stateChanged', { sessionId: WORKER, prev: state('working'), next: state('needs_user') })
    await flush()
    expect(h.sent).toEqual(
      expect.arrayContaining([
        { chatId: '42', text: expect.stringMatching(/^Reply\.\n\n⏸ It is waiting/) },
        { chatId: '42', threadRef: '77', text: expect.stringMatching(/^Reply\.\n\n⏸ It is waiting/) },
      ]),
    )
    expect(h.sent).toHaveLength(2)
  })

  it('says so when the attached session stops running', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A')
    h.sent.length = 0
    h.bus.emit('session.exited', { sessionId: WORKER, code: 0 })
    await flush()
    expect(texts(h)).toEqual([
      '⏹ The attached session stopped running. Messages here will not reach it until /wake; /detach returns this chat to the superagent.',
    ])
  })

  it('keeps the attachment across a restart', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A')
    const after = await h.restart()
    await after.inbound('still there?')
    expect(after.port.send).toHaveBeenCalledWith(USER, WORKER, 'still there?')
    expect(after.sendTurn).not.toHaveBeenCalled()
  })

  it('an attachment made by an account the chat is no longer bound to speaks for nobody', async () => {
    const h = await makeHarness()
    await h.inbound('/attach POD-12-A')
    const rebound = await makeHarness({ store: h.store, bindings: [binding('42', OTHER)] })
    await rebound.inbound('who am I talking to?')
    expect(rebound.port.send).not.toHaveBeenCalled()
    expect(rebound.store.rows.size).toBe(0)
    expect(rebound.sendTurn).toHaveBeenCalledTimes(1)
  })
})
