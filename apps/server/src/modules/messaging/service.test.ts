import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '@podium/protocol'
import { EventBus } from '../bus'
import type { MessagingIssueTopicRow } from '../../store/messaging-topics'
import { MessagingService, TYPING_REFRESH_MS, type MessagingDeps } from './service'
import { chunkTelegramText, parseTelegramUpdates } from './telegram'
import { TOPIC_INACTIVITY_MS } from './topic-recap'
import type { ChannelAdapter, InboundChatMessage } from './types'

describe('parseTelegramUpdates', () => {
  it('extracts text messages and the last update id', () => {
    const { messages, callbacks, lastUpdateId } = parseTelegramUpdates([
      {
        update_id: 10,
        message: {
          text: 'hello',
          chat: { id: 42 },
          from: { first_name: 'Mika', username: 'mika' },
        },
      },
      { update_id: 11, message: { chat: { id: 42 }, photo: [{}] } },
      { update_id: 12, edited_message: { text: 'edited', chat: { id: 42 } } },
    ])
    expect(messages).toEqual([
      { updateId: 10, chatId: '42', text: 'hello', senderLabel: '@mika' },
    ])
    expect(callbacks).toEqual([])
    expect(lastUpdateId).toBe(12)
  })

  it('extracts callback_query presses', () => {
    const { callbacks } = parseTelegramUpdates([
      {
        update_id: 3,
        callback_query: {
          id: 'cb1',
          data: 'i:iss_abc',
          from: { first_name: 'Mika' },
          message: { chat: { id: 42 }, message_thread_id: 5 },
        },
      },
    ])
    expect(callbacks).toEqual([
      {
        updateId: 3,
        chatId: '42',
        threadRef: '5',
        callbackQueryId: 'cb1',
        data: 'i:iss_abc',
        senderLabel: 'Mika',
      },
    ])
  })

  it('skips bot senders and carries forum topic ids as threadRef', () => {
    const { messages } = parseTelegramUpdates([
      {
        update_id: 1,
        message: { text: 'from bot', chat: { id: 1 }, from: { is_bot: true } },
      },
      {
        update_id: 2,
        message: { text: 'in topic', chat: { id: 1 }, message_thread_id: 77 },
      },
    ])
    expect(messages).toEqual([{ updateId: 2, chatId: '1', threadRef: '77', text: 'in topic' }])
  })

  it('tolerates garbage', () => {
    expect(parseTelegramUpdates(undefined).messages).toEqual([])
    expect(parseTelegramUpdates([null, 3, { update_id: 'x' }]).messages).toEqual([])
  })
})

describe('chunkTelegramText', () => {
  it('passes short text through untouched', () => {
    expect(chunkTelegramText('hi')).toEqual(['hi'])
  })

  it('splits long text at newline boundaries under the cap', () => {
    const para = 'a'.repeat(3000)
    const chunks = chunkTelegramText(`${para}\n${para}`, 4000)
    expect(chunks).toEqual([para, para])
  })

  it('hard-splits a single unbroken run', () => {
    const chunks = chunkTelegramText('x'.repeat(9000), 4000)
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000])
  })
})

interface Harness {
  service: MessagingService
  bus: EventBus
  inbound: (text: string, opts?: { threadRef?: string; callback?: { id: string; data: string } }) => void
  sent: Array<{ chatId: string; text: string; threadRef?: string; buttons?: unknown }>
  typingCalls: Array<{ chatId: string; threadRef?: string }>
  sendTurn: ReturnType<typeof vi.fn>
  interruptTurn: ReturnType<typeof vi.fn>
  restartThread: ReturnType<typeof vi.fn>
  startBtwTurn: ReturnType<typeof vi.fn>
  ensureConciergeThread: ReturnType<typeof vi.fn>
  registerTelegramCommands: ReturnType<typeof vi.fn>
  createForumTopic: ReturnType<typeof vi.fn>
  answerCallback: ReturnType<typeof vi.fn>
  readTranscript: ReturnType<typeof vi.fn>
  getSuperagentThread: ReturnType<typeof vi.fn>
  topicRows: MessagingIssueTopicRow[]
  topics: NonNullable<MessagingDeps['topics']>
  nowMs: { value: number }
}

function makeTopicsStore(): NonNullable<MessagingDeps['topics']> {
  const rows: MessagingIssueTopicRow[] = []
  return {
    listForChat: (chatId) => rows.filter((r) => r.chatId === chatId),
    getByIssue: (chatId, issueId) => rows.find((r) => r.chatId === chatId && r.issueId === issueId),
    getByThreadRef: (chatId, threadRef) =>
      rows.find((r) => r.chatId === chatId && r.threadRef === threadRef),
    upsert: (row) => {
      const i = rows.findIndex((r) => r.chatId === row.chatId && r.issueId === row.issueId)
      if (i >= 0) rows[i] = row
      else rows.push(row)
    },
  }
}

const sampleTranscript: TranscriptItem[] = [
  { id: '1', role: 'user', text: 'fix the race' },
  { id: '2', role: 'assistant', text: 'Looking at the lock path…' },
  { id: '3', role: 'tool', text: '', toolName: 'Read' },
  { id: '4', role: 'assistant', text: 'Root cause is a stale lease.' },
]

function liveIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'iss_i1',
    seq: 9,
    displayRef: 'POD-9',
    title: 'Slash commands',
    stage: 'in_progress',
    description: '',
    repoPath: '/p',
    worktreePath: null,
    branch: null,
    parentBranch: '',
    defaultAgent: 'grok',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    archived: false,
    readAt: null,
    unread: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    sessions: [
      {
        sessionId: 'sess_1',
        agentKind: 'grok',
        title: 'work',
        cwd: '/p',
        status: 'live',
        controllerId: null,
        geometry: { cols: 80, rows: 24 },
        epoch: 0,
        clientCount: 0,
        createdAt: '2026-07-16T00:00:00.000Z',
        lastActiveAt: '2026-07-16T01:00:00.000Z',
        origin: { kind: 'spawn' },
        archived: false,
        readAt: null,
        unread: false,
        issueId: 'iss_i1',
      },
    ],
    sessionSummary: { live: 1, total: 1 },
    ...overrides,
  }
}

function makeHarness(
  opts: {
    sendTurnImpl?: () => Promise<unknown>
    issues?: MessagingDeps['issues']
    sessionIssueId?: MessagingDeps['sessionIssueId']
    interruptTurnImpl?: () => void
    restartThreadImpl?: () => void
    topicRecap?: boolean
    transcriptItems?: TranscriptItem[]
  } = {},
): Harness {
  const bus = new EventBus()
  const sent: Array<{ chatId: string; text: string; threadRef?: string; buttons?: unknown }> = []
  const typingCalls: Array<{ chatId: string; threadRef?: string }> = []
  let onMessage: ((msg: InboundChatMessage) => void) | undefined
  const registerTelegramCommands = vi.fn(async () => {})
  const createForumTopic = vi.fn(async () => ({ threadRef: '9001' }))
  const answerCallback = vi.fn(async () => {})
  const nowMs = { value: 1_000_000 }
  const adapter: ChannelAdapter = {
    channel: 'telegram',
    start: (cb) => {
      onMessage = cb
    },
    stop: () => {},
    send: async (target, text, opts) => {
      sent.push({
        chatId: target.chatId,
        text,
        ...(target.threadRef ? { threadRef: target.threadRef } : {}),
        ...(opts?.replyMarkup ? { buttons: opts.replyMarkup.inlineKeyboard } : {}),
      })
    },
    createForumTopic,
    answerCallback,
    sendTyping: (target) => {
      typingCalls.push({
        chatId: target.chatId,
        ...(target.threadRef ? { threadRef: target.threadRef } : {}),
      })
    },
  }
  const sendTurn = vi.fn(
    opts.sendTurnImpl ??
      (() => Promise.resolve({ threadId: 'global', podiumSessionId: 'ps1' })),
  )
  const interruptTurn = vi.fn(opts.interruptTurnImpl ?? (() => {}))
  const restartThread = vi.fn(opts.restartThreadImpl ?? (() => {}))
  const startBtwTurn = vi.fn(({ sessionId }: { sessionId: string }) => ({
    threadId: `btw_${sessionId}`,
    isNew: true,
  }))
  const ensureConciergeThread = vi.fn(({ repoPath }: { repoPath: string }) => ({
    threadId: `concierge_${Buffer.from(repoPath, 'utf8').toString('base64url')}`,
    isNew: true,
  }))
  const topicRows: MessagingIssueTopicRow[] = []
  const topics = makeTopicsStore()
  const getSuperagentThread = vi.fn((threadId: string) => {
    if (threadId.startsWith('btw_')) {
      return { originSessionId: threadId.slice(4), podiumSessionId: null }
    }
    return { podiumSessionId: 'pod_concierge' }
  })
  const readTranscript = vi.fn(async () => ({
    items: opts.transcriptItems ?? sampleTranscript,
  }))
  const service = new MessagingService({
    bus,
    getSettings: () =>
      ({
        notifications: {
          web: true,
          ntfyTopic: '',
          telegramBotToken: 'tok',
          telegramChatId: '42',
        },
      }) as never,
    superagent: {
      sendTurn: sendTurn as never,
      interruptTurn: interruptTurn as never,
      restartThread: restartThread as never,
      startBtwTurn: startBtwTurn as never,
      ensureConciergeThread: ensureConciergeThread as never,
    },
    topics,
    ...(opts.issues ? { issues: opts.issues } : {}),
    ...(opts.sessionIssueId ? { sessionIssueId: opts.sessionIssueId } : {}),
    ...(opts.topicRecap
      ? {
          topicRecap: {
            getSuperagentThread: getSuperagentThread as never,
            readTranscript: readTranscript as never,
          },
          now: () => nowMs.value,
        }
      : {}),
    createTelegram: () => adapter,
    registerTelegramCommands,
  })
  service.configure()
  return {
    service,
    bus,
    sent,
    typingCalls,
    sendTurn,
    interruptTurn,
    restartThread,
    startBtwTurn,
    ensureConciergeThread,
    registerTelegramCommands,
    createForumTopic,
    answerCallback,
    readTranscript,
    getSuperagentThread,
    topicRows,
    topics,
    nowMs,
    inbound: (text, opts) =>
      onMessage?.({
        source: {
          channel: 'telegram',
          chatId: '42',
          ...(opts?.threadRef ? { threadRef: opts.threadRef } : {}),
        },
        text,
        ...(opts?.callback ? { callback: opts.callback } : {}),
      }),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const flushMicro = () => Promise.resolve()

describe('MessagingService', () => {
  it('dispatches an inbound message as a global-thread turn and relays the reply', async () => {
    const h = makeHarness()
    h.inbound('status?')
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sendTurn.mock.calls[0]![0]!.threadId).toBe('global')
    expect(h.sendTurn.mock.calls[0]![0]!.text).toContain('status?')
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: true,
      output: 'all good',
    })
    await flush()
    expect(h.sent).toEqual([{ chatId: '42', text: 'all good' }])
  })

  it('does not double-dispatch when two messages land before the first ack', async () => {
    const h = makeHarness()
    h.inbound('first')
    h.inbound('second') // no flush between — dispatch promise still pending
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sendTurn.mock.calls[0]![0]!.text).toContain('first')
  })

  it('queues while a turn is in flight and drains on turnEnded', async () => {
    const h = makeHarness()
    h.inbound('first')
    await flush()
    h.inbound('second')
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: true,
      output: 'reply one',
    })
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(2)
    expect(h.sendTurn.mock.calls[1]![0]!.text).toContain('second')
  })

  it('keeps the message queued when someone else holds the thread, retries on turnEnded', async () => {
    let busy = true
    const h = makeHarness({
      sendTurnImpl: () =>
        busy
          ? Promise.reject(new Error('a turn is already running on this thread'))
          : Promise.resolve({ threadId: 'global', podiumSessionId: 'ps1' }),
    })
    h.inbound('hello')
    await flush()
    expect(h.sent).toEqual([]) // no error surfaced — just queued
    busy = false
    // A web-dispatched turn (not awaited by the bridge) finishes:
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: true,
      output: 'web reply',
    })
    await flush()
    expect(h.sent).toEqual([]) // web turn's reply is not relayed
    expect(h.sendTurn).toHaveBeenCalledTimes(2) // retried and accepted
  })

  describe('typing indicator', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('starts at inbound accept before sendTurn resolves', async () => {
      let resolveTurn!: () => void
      const h = makeHarness({
        sendTurnImpl: () =>
          new Promise((resolve) => {
            resolveTurn = () => resolve({ threadId: 'global', podiumSessionId: 'ps1' })
          }),
      })
      h.inbound('hello')
      await flushMicro()
      expect(h.typingCalls).toEqual([{ chatId: '42' }])
      expect(h.sendTurn).toHaveBeenCalledTimes(1)
      resolveTurn()
      await flushMicro()
      expect(h.typingCalls).toEqual([{ chatId: '42' }])
    })

    it(`refreshes every ${TYPING_REFRESH_MS}ms while awaiting`, async () => {
      vi.useFakeTimers()
      const h = makeHarness()
      h.inbound('hello')
      await flushMicro()
      expect(h.typingCalls).toHaveLength(1)
      vi.advanceTimersByTime(TYPING_REFRESH_MS)
      expect(h.typingCalls).toHaveLength(2)
      vi.advanceTimersByTime(TYPING_REFRESH_MS)
      expect(h.typingCalls).toHaveLength(3)
    })

    it('clears typing on turnEnded reply', async () => {
      vi.useFakeTimers()
      const h = makeHarness()
      h.inbound('hello')
      await flushMicro()
      h.bus.emit('superagent.turnEnded', {
        threadId: 'global',
        podiumSessionId: 'ps1',
        ok: true,
        output: 'done',
      })
      await flushMicro()
      const countAfterReply = h.typingCalls.length
      vi.advanceTimersByTime(TYPING_REFRESH_MS * 3)
      expect(h.typingCalls).toHaveLength(countAfterReply)
    })

    it('clears typing on failed turn', async () => {
      vi.useFakeTimers()
      const h = makeHarness()
      h.inbound('hello')
      await flushMicro()
      h.bus.emit('superagent.turnEnded', {
        threadId: 'global',
        podiumSessionId: 'ps1',
        ok: false,
        error: 'boom',
      })
      await flushMicro()
      const countAfterError = h.typingCalls.length
      vi.advanceTimersByTime(TYPING_REFRESH_MS * 3)
      expect(h.typingCalls).toHaveLength(countAfterError)
    })

    it('clears typing on dispatch error', async () => {
      vi.useFakeTimers()
      const h = makeHarness({
        sendTurnImpl: () => Promise.reject(new Error('thread is open in a terminal')),
      })
      h.inbound('hello')
      await flushMicro()
      await flushMicro()
      expect(h.sent).toHaveLength(1)
      const countAfterError = h.typingCalls.length
      vi.advanceTimersByTime(TYPING_REFRESH_MS * 3)
      expect(h.typingCalls).toHaveLength(countAfterError)
    })

    it('clears typing when the thread is busy elsewhere', async () => {
      vi.useFakeTimers()
      const h = makeHarness({
        sendTurnImpl: () =>
          Promise.reject(new Error('a turn is already running on this thread')),
      })
      h.inbound('hello')
      await flushMicro()
      await flushMicro()
      const countAfterBusy = h.typingCalls.length
      vi.advanceTimersByTime(TYPING_REFRESH_MS * 3)
      expect(h.typingCalls).toHaveLength(countAfterBusy)
    })

    it('threads typing into the inbound forum topic', async () => {
      const h = makeHarness()
      h.topics.upsert({
        issueId: 'iss_i1',
        chatId: '42',
        threadRef: '9001',
        superagentThreadId: 'btw_sess_1',
        updatedAt: '2026-07-16T00:00:00.000Z',
      })
      h.service.configure()
      h.inbound('status in topic', { threadRef: '9001' })
      await flushMicro()
      expect(h.typingCalls).toEqual([{ chatId: '42', threadRef: '9001' }])
      expect(h.sendTurn.mock.calls[0]![0]!.threadId).toBe('btw_sess_1')
    })
  })

  describe('ambient session working typing [spec:SP-62c3]', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    function agentState(phase: 'working' | 'idle' | 'needs_user' | 'errored' | 'ended' | 'compacting') {
      return {
        phase,
        since: '2026-07-16T00:00:00.000Z',
        openTaskCount: 0,
        ...(phase === 'needs_user' ? { need: { kind: 'question' as const } } : {}),
        ...(phase === 'errored'
          ? { error: { class: 'server_error', retryable: true } }
          : {}),
        ...(phase === 'idle' ? { idle: { kind: 'done' as const } } : {}),
      }
    }

    function bindTopic(
      h: Harness,
      opts: { sessionId?: string; issueId?: string; threadRef?: string } = {},
    ): { sessionId: string; issueId: string; threadRef: string } {
      const sessionId = opts.sessionId ?? 's_agent'
      const issueId = opts.issueId ?? 'iss_bound'
      const threadRef = opts.threadRef ?? '555'
      h.topics.upsert({
        issueId,
        chatId: '42',
        threadRef,
        superagentThreadId: `btw_${sessionId}`,
        updatedAt: '2026-07-16T00:00:00.000Z',
      })
      return { sessionId, issueId, threadRef }
    }

    it('sends typing into the bound topic when the session enters working', () => {
      const h = makeHarness({
        sessionIssueId: (id) => (id === 's_agent' ? 'iss_bound' : null),
      })
      const { sessionId, threadRef } = bindTopic(h)
      h.bus.emit('session.stateChanged', {
        sessionId,
        prev: undefined,
        next: agentState('working'),
      })
      expect(h.typingCalls).toEqual([{ chatId: '42', threadRef }])
    })

    it('does not start ambient typing on compacting (only phase===working)', () => {
      const h = makeHarness({
        sessionIssueId: (id) => (id === 's_agent' ? 'iss_bound' : null),
      })
      const { sessionId } = bindTopic(h)
      h.bus.emit('session.stateChanged', {
        sessionId,
        prev: agentState('idle'),
        next: agentState('compacting'),
      })
      expect(h.typingCalls).toEqual([])
    })

    it(`refreshes ambient typing every ${TYPING_REFRESH_MS}ms while working`, () => {
      vi.useFakeTimers()
      const h = makeHarness({
        sessionIssueId: (id) => (id === 's_agent' ? 'iss_bound' : null),
      })
      const { sessionId } = bindTopic(h)
      h.bus.emit('session.stateChanged', {
        sessionId,
        prev: undefined,
        next: agentState('working'),
      })
      expect(h.typingCalls).toHaveLength(1)
      vi.advanceTimersByTime(TYPING_REFRESH_MS)
      expect(h.typingCalls).toHaveLength(2)
      vi.advanceTimersByTime(TYPING_REFRESH_MS)
      expect(h.typingCalls).toHaveLength(3)
    })

    it.each(['idle', 'needs_user', 'errored', 'ended', 'compacting'] as const)(
      'stops ambient typing on %s',
      (phase) => {
        vi.useFakeTimers()
        const h = makeHarness({
          sessionIssueId: (id) => (id === 's_agent' ? 'iss_bound' : null),
        })
        const { sessionId } = bindTopic(h)
        h.bus.emit('session.stateChanged', {
          sessionId,
          prev: undefined,
          next: agentState('working'),
        })
        const countWhileWorking = h.typingCalls.length
        h.bus.emit('session.stateChanged', {
          sessionId,
          prev: agentState('working'),
          next: agentState(phase),
        })
        vi.advanceTimersByTime(TYPING_REFRESH_MS * 3)
        expect(h.typingCalls).toHaveLength(countWhileWorking)
      },
    )

    it('stops ambient typing on session.exited', () => {
      vi.useFakeTimers()
      const h = makeHarness({
        sessionIssueId: (id) => (id === 's_agent' ? 'iss_bound' : null),
      })
      const { sessionId } = bindTopic(h)
      h.bus.emit('session.stateChanged', {
        sessionId,
        prev: undefined,
        next: agentState('working'),
      })
      const countWhileWorking = h.typingCalls.length
      h.bus.emit('session.exited', { sessionId, code: 0 })
      vi.advanceTimersByTime(TYPING_REFRESH_MS * 3)
      expect(h.typingCalls).toHaveLength(countWhileWorking)
    })

    it('does not indicate for sessions without a bound topic', () => {
      vi.useFakeTimers()
      const h = makeHarness({
        sessionIssueId: () => 'iss_unbound',
      })
      h.bus.emit('session.stateChanged', {
        sessionId: 's_unbound',
        prev: undefined,
        next: agentState('working'),
      })
      vi.advanceTimersByTime(TYPING_REFRESH_MS * 2)
      expect(h.typingCalls).toEqual([])
    })

    it('does not double-fire when superagent-turn typing already covers the topic', async () => {
      vi.useFakeTimers()
      const h = makeHarness({
        sessionIssueId: (id) => (id === 's_agent' ? 'iss_bound' : null),
      })
      const { sessionId, threadRef } = bindTopic(h, { threadRef: '9001' })
      h.topics.upsert({
        issueId: 'iss_bound',
        chatId: '42',
        threadRef,
        superagentThreadId: `btw_${sessionId}`,
        updatedAt: '2026-07-16T00:00:00.000Z',
      })
      // Superagent turn typing first (inbound into the bound topic).
      h.inbound('status in topic', { threadRef })
      await flushMicro()
      expect(h.typingCalls).toEqual([{ chatId: '42', threadRef }])
      // Ambient working signal for the same topic — must share the lease.
      h.bus.emit('session.stateChanged', {
        sessionId,
        prev: undefined,
        next: agentState('working'),
      })
      expect(h.typingCalls).toHaveLength(1)
      vi.advanceTimersByTime(TYPING_REFRESH_MS)
      expect(h.typingCalls).toHaveLength(2)
      // Turn ends — ambient still owns the lease, so typing continues.
      h.bus.emit('superagent.turnEnded', {
        threadId: `btw_${sessionId}`,
        podiumSessionId: 'ps1',
        ok: true,
        output: 'done',
      })
      await flushMicro()
      const afterTurn = h.typingCalls.length
      vi.advanceTimersByTime(TYPING_REFRESH_MS)
      expect(h.typingCalls).toHaveLength(afterTurn + 1)
    })

    it('keeps a single refresh cadence when ambient starts before the turn', async () => {
      vi.useFakeTimers()
      const h = makeHarness({
        sessionIssueId: (id) => (id === 's_agent' ? 'iss_bound' : null),
      })
      const { sessionId, threadRef } = bindTopic(h, { threadRef: '9001' })
      h.bus.emit('session.stateChanged', {
        sessionId,
        prev: undefined,
        next: agentState('working'),
      })
      expect(h.typingCalls).toHaveLength(1)
      h.inbound('status in topic', { threadRef })
      await flushMicro()
      // Second owner must not fire an extra immediate typing action.
      expect(h.typingCalls).toHaveLength(1)
      vi.advanceTimersByTime(TYPING_REFRESH_MS)
      expect(h.typingCalls).toHaveLength(2)
    })
  })

  it('surfaces terminal dispatch errors and keeps the queue moving', async () => {
    const h = makeHarness({
      sendTurnImpl: () => Promise.reject(new Error('thread is open in a terminal')),
    })
    h.inbound('hello')
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('thread is open in a terminal')
  })

  it('relays a failed turn as an error message', async () => {
    const h = makeHarness()
    h.inbound('hi')
    await flush()
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: false,
      error: 'harness died',
    })
    await flush()
    expect(h.sent[0]!.text).toContain('harness died')
  })

  it('registers slash commands via setMyCommands when the adapter starts', () => {
    const h = makeHarness()
    expect(h.registerTelegramCommands).toHaveBeenCalledTimes(1)
    expect(h.registerTelegramCommands).toHaveBeenCalledWith('tok')
  })

  it('routes /help locally without dispatching a turn', async () => {
    const h = makeHarness()
    h.inbound('/help')
    await flush()
    expect(h.sendTurn).not.toHaveBeenCalled()
    expect(h.sent[0]!.text).toContain('/issues')
  })

  it('routes /stop to interruptTurn', async () => {
    const h = makeHarness()
    h.inbound('/stop')
    await flush()
    expect(h.interruptTurn).toHaveBeenCalledWith({ threadId: 'global' })
    expect(h.sendTurn).not.toHaveBeenCalled()
  })

  it('routes /new to restartThread and drops the inbound queue', async () => {
    const h = makeHarness()
    h.inbound('queued')
    await flush()
    h.inbound('/new')
    await flush()
    expect(h.restartThread).toHaveBeenCalledWith({ threadId: 'global' })
    expect(h.sent.at(-1)!.text).toContain('restarted')
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: true,
      output: 'stale',
    })
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
  })

  it('routes /issues active through the issue list with inline buttons', async () => {
    const h = makeHarness({
      issues: {
        list: () =>
          [
            {
              id: 'iss_i1',
              seq: 9,
              displayRef: 'POD-9',
              title: 'Slash commands',
              stage: 'in_progress',
              description: '',
              repoPath: '/p',
              worktreePath: null,
              branch: null,
              parentBranch: '',
              defaultAgent: 'grok',
              defaultModel: 'auto',
              defaultEffort: 'auto',
              blockedBy: [],
              priority: 2,
              type: 'task',
              pinned: false,
              needsHuman: false,
              labels: [],
              deps: [],
              dependents: [],
              ready: true,
              blocked: false,
              deferred: false,
              childCount: 0,
              childDoneCount: 0,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-07-16T00:00:00.000Z',
              archived: false,
              readAt: null,
              unread: false,
              origin: 'human',
              audience: 'human',
              draft: false,
              sessions: [],
              sessionSummary: { live: 0, total: 0 },
            },
          ] as never,
      },
    })
    h.inbound('/issues active')
    await flush()
    expect(h.sendTurn).not.toHaveBeenCalled()
    expect(h.sent[0]!.text).toContain('POD-9 Slash commands')
    expect(h.sent[0]!.buttons).toEqual([[{ label: 'POD-9 Slash commands', data: 'i:iss_i1' }]])
  })

  it('opens a forum topic and maps threadRef to btw on issue button press', async () => {
    const h = makeHarness({
      issues: { list: () => [liveIssue()] as never },
    })
    h.inbound('', { callback: { id: 'cb1', data: 'i:iss_i1' } })
    await flush()
    expect(h.createForumTopic).toHaveBeenCalledWith('42', 'POD-9 Slash commands')
    expect(h.startBtwTurn).toHaveBeenCalledWith({ sessionId: 'sess_1' })
    expect(h.answerCallback).toHaveBeenCalledWith('cb1', 'Created topic')
    expect(h.sent[0]!.threadRef).toBe('9001')
    h.inbound('status in topic', { threadRef: '9001' })
    await flush()
    expect(h.sendTurn.mock.calls[0]![0]!.threadId).toBe('btw_sess_1')
    expect(h.topics.getByThreadRef('42', '9001')?.superagentThreadId).toBe('btw_sess_1')
  })

  it('posts a transcript recap when creating an issue topic [spec:SP-62c3]', async () => {
    const h = makeHarness({
      topicRecap: true,
      issues: { list: () => [liveIssue()] as never },
    })
    h.inbound('', { callback: { id: 'cb1', data: 'i:iss_i1' } })
    await flush()
    expect(h.createForumTopic).toHaveBeenCalled()
    expect(h.readTranscript).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      direction: 'before',
      limit: 50,
    })
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]!.text).toContain('POD-9 Slash commands')
    expect(h.sent[1]!.threadRef).toBe('9001')
    expect(h.sent[1]!.text).toContain('Recent in this conversation:')
    expect(h.sent[1]!.text).toContain('You: fix the race')
    expect(h.sent[1]!.text).toContain('Agent: Root cause is a stale lease.')
  })

  it('posts a recap on issue-button re-tap of an existing topic [spec:SP-62c3]', async () => {
    const h = makeHarness({
      topicRecap: true,
      issues: { list: () => [liveIssue()] as never },
    })
    h.topics.upsert({
      issueId: 'iss_i1',
      chatId: '42',
      threadRef: '9001',
      superagentThreadId: 'btw_sess_1',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })
    h.inbound('', { callback: { id: 'cb-re', data: 'i:iss_i1' } })
    await flush()
    expect(h.createForumTopic).not.toHaveBeenCalled()
    expect(h.answerCallback).toHaveBeenCalledWith('cb-re', 'Opened topic')
    expect(h.sent.some((s) => s.text.includes('Recent in this conversation:'))).toBe(true)
    expect(h.readTranscript).toHaveBeenCalled()
  })

  it('posts inactivity recap before dispatching a topic message after 30min [spec:SP-62c3]', async () => {
    const h = makeHarness({
      topicRecap: true,
      issues: { list: () => [liveIssue()] as never },
    })
    h.inbound('', { callback: { id: 'cb1', data: 'i:iss_i1' } })
    await flush()
    h.sent.length = 0
    h.readTranscript.mockClear()
    h.sendTurn.mockClear()

    // Active again within the window — no recap.
    h.nowMs.value += 5 * 60 * 1000
    h.inbound('still here', { threadRef: '9001' })
    await flush()
    expect(h.readTranscript).not.toHaveBeenCalled()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sent).toEqual([])

    // After the inactivity gap, recap lands before the turn is dispatched.
    h.bus.emit('superagent.turnEnded', {
      threadId: 'btw_sess_1',
      podiumSessionId: 'ps1',
      ok: true,
      output: 'ack',
    })
    await flush()
    h.sent.length = 0
    h.readTranscript.mockClear()
    h.sendTurn.mockClear()

    h.nowMs.value += TOPIC_INACTIVITY_MS + 1
    h.inbound('what was the lease issue?', { threadRef: '9001' })
    await flush()
    expect(h.readTranscript).toHaveBeenCalled()
    expect(h.sent[0]!.text).toContain('Recent in this conversation:')
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sendTurn.mock.calls[0]![0]!.text).toContain('what was the lease issue?')
    // Recap is ordered before the turn leaves the bridge.
    const recapIdx = h.sent.findIndex((s) => s.text.includes('Recent in this conversation:'))
    expect(recapIdx).toBe(0)
  })

  it('binds topics to repo concierge when the issue has no agent session', async () => {
    const h = makeHarness({
      issues: {
        list: () =>
          [
            {
              id: 'iss_i2',
              seq: 10,
              displayRef: 'POD-10',
              title: 'No sessions',
              stage: 'planning',
              description: '',
              repoPath: '/my/repo',
              worktreePath: null,
              branch: null,
              parentBranch: '',
              defaultAgent: 'grok',
              defaultModel: 'auto',
              defaultEffort: 'auto',
              blockedBy: [],
              priority: 2,
              type: 'task',
              pinned: false,
              needsHuman: false,
              labels: [],
              deps: [],
              dependents: [],
              ready: false,
              blocked: false,
              deferred: false,
              childCount: 0,
              childDoneCount: 0,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-07-16T00:00:00.000Z',
              archived: false,
              readAt: null,
              unread: false,
              origin: 'human',
              audience: 'human',
              draft: false,
              sessions: [],
              sessionSummary: { live: 0, total: 0 },
            },
          ] as never,
      },
    })
    h.inbound('', { callback: { id: 'cb2', data: 'i:iss_i2' } })
    await flush()
    expect(h.ensureConciergeThread).toHaveBeenCalledWith({ repoPath: '/my/repo' })
    h.inbound('hello concierge', { threadRef: '9001' })
    await flush()
    expect(h.sendTurn.mock.calls[0]![0]!.threadId).toMatch(/^concierge_/)
  })

  it('guides the user to enable topic mode when the chat is not a forum', async () => {
    const h = makeHarness({
      issues: {
        list: () =>
          [
            {
              id: 'iss_i2',
              seq: 10,
              displayRef: 'POD-10',
              title: 'No sessions',
              stage: 'planning',
              repoPath: '/my/repo',
              sessions: [],
              sessionSummary: { total: 0, byPhase: {} },
            },
          ] as never,
      },
    })
    h.createForumTopic.mockRejectedValueOnce(new Error('Bad Request: the chat is not a forum'))
    h.inbound('', { callback: { id: 'cb3', data: 'i:iss_i2' } })
    await flush()
    expect(h.answerCallback).toHaveBeenCalledWith('cb3', 'Topic mode not enabled for this bot')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('Thread mode')
    expect(h.sent[0]!.threadRef).toBeUndefined()
  })

  it('still dispatches unknown slash commands to the superagent', async () => {
    const h = makeHarness()
    h.inbound('/model opus')
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sendTurn.mock.calls[0]![0]!.text).toContain('/model opus')
  })

  it('sendNotice routes through the adapter with formatted text', async () => {
    const h = makeHarness()
    h.service.sendNotice('keyboard needs you\n\nSQLite or Postgres?', {
      botToken: 'tok',
      chatId: '42',
    })
    await flush()
    expect(h.sent).toEqual([
      { chatId: '42', text: 'keyboard needs you\n\nSQLite or Postgres?' },
    ])
  })

  it('sendNotice with sessionId routes to the bound issue forum topic', async () => {
    const h = makeHarness({
      sessionIssueId: (sessionId) => (sessionId === 's_pod' ? 'iss_pod' : null),
    })
    h.topics.upsert({
      issueId: 'iss_pod',
      chatId: '42',
      threadRef: '555',
      superagentThreadId: 'btw_s_pod',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })
    h.inbound('in another topic', { threadRef: '77' })
    h.service.sendNotice('keyboard needs you\n\nSQLite or Postgres?', {
      botToken: 'tok',
      chatId: '42',
    }, { sessionId: 's_pod' })
    await flush()
    expect(h.sent).toEqual([
      {
        chatId: '42',
        threadRef: '555',
        text: 'keyboard needs you\n\nSQLite or Postgres?',
      },
    ])
  })

  it('sendNotice with sessionId falls back to main chat when the issue has no bound topic', async () => {
    const h = makeHarness({
      sessionIssueId: () => 'iss_unbound',
    })
    h.inbound('in topic', { threadRef: '77' })
    h.service.sendNotice('keyboard needs you\n\nSQLite or Postgres?', {
      botToken: 'tok',
      chatId: '42',
    }, { sessionId: 's1' })
    await flush()
    expect(h.sent).toEqual([
      {
        chatId: '42',
        text: 'keyboard needs you\n\nSQLite or Postgres?',
      },
    ])
  })

  it('sendNotice threads into the last inbound forum topic when no sessionId is given', async () => {
    const h = makeHarness()
    const bus = h.bus
    let onMessage: ((msg: InboundChatMessage) => void) | undefined
    const sent: Array<{ chatId: string; threadRef?: string; text: string }> = []
    const adapter: ChannelAdapter = {
      channel: 'telegram',
      start: (cb) => {
        onMessage = cb
      },
      stop: () => {},
      send: async (target, text) => {
        sent.push({
          chatId: target.chatId,
          ...(target.threadRef ? { threadRef: target.threadRef } : {}),
          text,
        })
      },
    }
    const service = new MessagingService({
      bus,
      getSettings: () =>
        ({
          notifications: {
            web: true,
            ntfyTopic: '',
            telegramBotToken: 'tok',
            telegramChatId: '42',
          },
        }) as never,
      superagent: {
        sendTurn: vi.fn(() => Promise.resolve({ threadId: 'global', podiumSessionId: 'ps1' })),
        interruptTurn: vi.fn(),
        restartThread: vi.fn(),
        startBtwTurn: vi.fn(({ sessionId }: { sessionId: string }) => ({
          threadId: `btw_${sessionId}`,
          isNew: true,
        })),
        ensureConciergeThread: vi.fn(({ repoPath }: { repoPath: string }) => ({
          threadId: `concierge_${Buffer.from(repoPath, 'utf8').toString('base64url')}`,
          isNew: true,
        })),
      },
      createTelegram: () => adapter,
      registerTelegramCommands: vi.fn(async () => {}),
    })
    service.configure()
    onMessage?.({
      source: { channel: 'telegram', chatId: '42', threadRef: '77' },
      text: 'in topic',
    })
    service.sendNotice('keyboard needs you\n\nSQLite or Postgres?', {
      botToken: 'tok',
      chatId: '42',
    })
    await flush()
    expect(sent).toEqual([
      {
        chatId: '42',
        threadRef: '77',
        text: 'keyboard needs you\n\nSQLite or Postgres?',
      },
    ])
  })

  it('sendNotice falls back to direct send when config does not match the live adapter', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    vi.stubGlobal('fetch', fetch)
    const h = makeHarness()
    h.service.sendNotice('t\n\nb', { botToken: 'other', chatId: '42' })
    await flush()
    expect(h.sent).toEqual([])
    expect(fetch).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('sendNotice falls back to direct send when the bridge is stopped', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    vi.stubGlobal('fetch', fetch)
    const h = makeHarness()
    h.service.stop()
    h.service.sendNotice('t\n\nb', { botToken: 'tok', chatId: '42' })
    await flush()
    expect(h.sent).toEqual([])
    expect(fetch).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
