import {
  asSessionId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
  type TranscriptItem,
} from '@podium/model'
import { fireEvent } from '@testing-library/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './test-support/client-core-mock'
import { outboxChatSendActions } from './test-support/outbox-chat-send'

// ---------------------------------------------------------------------------
// THE QUESTION THAT IS NOT IN THE TRANSCRIPT (POD-1273).
//
// Claude Code writes a tool call into its transcript only once the call
// RESOLVES, so for the whole time an AskUserQuestion is waiting there is no item
// for the chat's transcript-derived card to render: the sidebar said blocked,
// the feed showed nothing, and the composer was closed because the session is
// `needs_user` — no way to answer from the web at all.
//
// The hook channel announced the ask when it opened and the harness carries it
// on `agentState.need.interview`. These cover the round trip: state draws the
// card, the card answers through the same server route a transcript one does,
// and the transcript takes the question back the moment it can speak for itself.
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void

const fakeHub = {
  subscribeTranscript(_sessionId: SessionId, _since: string | undefined, _cb: DeltaCb): () => void {
    return () => {}
  },
}

interface ReadCall {
  resolve: (r: { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }) => void
  reject: (err: unknown) => void
}

const reads: ReadCall[] = []
const answerMutate = vi.fn(async (_input: unknown) => ({ ok: true }))
const fakeTrpc = {
  sessions: {
    transcriptRead: {
      query() {
        return new Promise((resolve, reject) => {
          reads.push({ resolve, reject } as ReadCall)
        })
      },
    },
    sendText: { mutate: vi.fn(async (_input: unknown): Promise<{ ok: boolean; disposition?: string; position?: number }> => ({ ok: true })) },
    answerAskUserQuestion: { mutate: answerMutate },
    uploadImage: { mutate: vi.fn(async () => ({ path: '/x' })) },
  },
}

const fakeReplica = {
  available: false,
  hydrate: async () => ({ sessions: [], issues: [], conversations: [], cursor: null }),
  applySnapshot: () => {},
  applyChanges: () => {},
  getCursor: () => null,
  setCursor: () => {},
  transcriptWindow: () => undefined,
  putTranscriptWindow: () => {},
}

let storeSessions: SessionMeta[] = []

// Every chat send runs the REAL outbox, draining into `fakeTrpc` (POD-4762).
const chatSend = outboxChatSendActions(() => fakeTrpc)

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    sessions: storeSessions,
    drafts: {},
    setSessionDraft: vi.fn(),
    sendChat: chatSend.sendChat,
    chatSendsFor: chatSend.chatSendsFor,
    discardChat: chatSend.discardChat,
    setPanelMode: vi.fn(),
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
  })
  return {
    useStore,
    useSession: (id: string | undefined) =>
      storeSessions.find((session) => session.sessionId === id),
    useSessionDraft: () => '',
    useSessionExitKind: () => undefined,
    useRuntimeSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('@/lib/markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))

const { ChatView } = await import('./ChatView')

const INTERVIEW = {
  questions: [
    {
      question: 'Where should the clickable status icon land?',
      header: 'Placement',
      options: [{ label: 'The issue row' }, { label: 'The card header' }],
    },
  ],
}

function meta(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

const waiting = (): SessionMeta =>
  meta({
    agentState: {
      phase: 'needs_user',
      since: '2026-06-03T00:00:00.000Z',
      nativeSubagentCount: 0,
      need: { kind: 'question', summary: INTERVIEW.questions[0]?.question, interview: INTERVIEW },
    },
  } as unknown as Partial<SessionMetaInput>)

/** The transcript's own copy of the same ask, once Claude Code writes it down. */
const askItem = (over: Partial<TranscriptItem> = {}): TranscriptItem =>
  ({
    id: 'from-transcript',
    cursor: 'c1',
    role: 'tool',
    text: '',
    toolName: 'AskUserQuestion',
    toolUseId: 'u1',
    toolInputJson: JSON.stringify(INTERVIEW),
    ...over,
  }) as TranscriptItem

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  chatSend.reset()
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

/** Render the view and settle the transcript read with `items`. */
async function show(session: SessionMeta, items: TranscriptItem[]): Promise<void> {
  storeSessions = [session]
  act(() => {
    root.render(<ChatView sessionId={asSessionId('s1')} />)
  })
  await act(async () => {
    reads[0]?.resolve({ items, hasMore: false })
  })
  await flush()
}

const optionButtons = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('button[role="radio"], button[role="checkbox"]'),
]

const occurrences = (needle: string): number =>
  (container.textContent ?? '').split(needle).length - 1

describe('a pending question the transcript does not carry', () => {
  it('draws the card from agent state when the feed has nothing', async () => {
    await show(waiting(), [])
    expect(container.textContent).toContain('Where should the clickable status icon land?')
    // The native menu's option digits ride the label, as on a transcript card.
    expect(optionButtons().map((b) => b.textContent)).toEqual([
      '1The issue row',
      '2The card header',
    ])
  })

  it('answers through the same route a transcript card does', async () => {
    await show(waiting(), [])
    await act(async () => {
      optionButtons()[0]?.click()
    })
    await flush()
    expect(answerMutate).toHaveBeenCalledTimes(1)
    expect(answerMutate.mock.calls[0]?.[0]).toMatchObject({ choices: [{ optionIndices: [1] }] })
  })

  it('hands the question back when the transcript item lands, not showing it twice', async () => {
    await show(waiting(), [askItem()])
    expect(occurrences('Where should the clickable status icon land?')).toBe(1)
  })

  it('goes away when the wait ends, leaving the answered item to stand as history', async () => {
    await show(
      meta({
        agentState: {
          phase: 'working',
          since: '2026-06-03T00:00:00.000Z',
          nativeSubagentCount: 0,
        },
      } as unknown as Partial<SessionMetaInput>),
      [askItem({ toolResult: 'User selected "The issue row"' })],
    )
    expect(occurrences('Where should the clickable status icon land?')).toBe(1)
    // Read-only history: the answered card offers nothing to click.
    expect(optionButtons().every((b) => b.disabled)).toBe(true)
  })

  it('draws nothing when the wait is a permission prompt rather than a question', async () => {
    await show(
      meta({
        agentState: {
          phase: 'needs_user',
          since: '2026-06-03T00:00:00.000Z',
          nativeSubagentCount: 0,
          need: { kind: 'permission', summary: 'Bash', ask: { toolName: 'Bash' } },
        },
      } as unknown as Partial<SessionMetaInput>),
      [],
    )
    expect(optionButtons()).toHaveLength(0)
  })
})

describe('Codex async interviews in chat', () => {
  const question = () =>
    askItem({ id: 'async-question', toolName: 'request_user_input_async', toolUseId: 'call_async' })
  const ack: TranscriptItem = {
    id: 'ack',
    role: 'tool',
    text: '',
    toolUseId: 'call_async',
    toolResult: '{"accepted":true}',
  }

  it('reuses the card after acknowledgement and replies through chat instead of the native menu', async () => {
    await show(meta({ agentKind: 'codex' }), [question(), ack])
    expect(container.querySelector('[data-testid="ask-live"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="ask-skip"]')).toBeNull()
    await act(async () => optionButtons()[1]?.click())
    await flush()
    expect(answerMutate).not.toHaveBeenCalled()
    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledTimes(1)
    const sent = fakeTrpc.sessions.sendText.mutate.mock.calls[0]?.[0] as unknown as { text: string }
    expect(sent).toMatchObject({ sessionId: 's1' })
    expect(sent).toHaveProperty('mutationId', expect.stringMatching(/^msg_/))
    expect(JSON.parse(sent.text.split('\n')[1] ?? '')).toEqual([
      {
        answer: 'The card header',
        question: INTERVIEW.questions[0]?.question,
        questionItemId: '["request_user_input_async","call_async",0]',
      },
    ])
  })

  it('draws native JSON replies as readable answers and closes the card', async () => {
    const reply = JSON.stringify([
      {
        answer: 'main, using an isolated branch',
        question: INTERVIEW.questions[0]?.question,
        questionItemId: '["request_user_input_async","call_async",0]',
      },
    ])
    await show(meta({ agentKind: 'codex' }), [
      question(),
      ack,
      { id: 'answer-result', role: 'tool', text: '', toolUseId: 'call_async', toolResult: reply },
      { id: 'user-answer', role: 'user', text: reply },
    ])
    expect(container.querySelector('[data-testid="ask-live"]')).toBeNull()
    expect(container.querySelector('[data-testid="ask-receipt"]')?.textContent).toContain(
      'main, using an isolated branch',
    )
    expect(container.textContent).not.toContain('questionItemId')
    expect(container.textContent).not.toContain('accepted')
  })

  it('sends multi-question interviews with a free-text-only question in one reply', async () => {
    await show(meta({ agentKind: 'codex' }), [
      {
        ...question(),
        toolInputJson: JSON.stringify({
          questions: [
            { question: 'Where?', options: [{ label: 'main' }, { label: 'A branch' }] },
            { question: 'Any constraints?', options: [] },
          ],
        }),
      },
      ack,
    ])
    await act(async () => optionButtons()[0]?.click())
    expect(fakeTrpc.sessions.sendText.mutate).not.toHaveBeenCalled()
    const input = container.querySelector<HTMLInputElement>('[data-testid="ask-free-text"]')
    expect(input).not.toBeNull()
    await act(async () =>
      fireEvent.change(input as HTMLInputElement, {
        target: { value: 'Keep the backend unchanged.' },
      }),
    )
    const send = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Send answers',
    )
    await act(async () => send?.click())
    const sent = fakeTrpc.sessions.sendText.mutate.mock.calls[0]?.[0] as { text: string }
    expect(JSON.parse(sent.text.split('\n')[1] ?? '')).toEqual([
      {
        answer: 'main',
        question: 'Where?',
        questionItemId: '["request_user_input_async","call_async",0]',
      },
      {
        answer: 'Keep the backend unchanged.',
        question: 'Any constraints?',
        questionItemId: '["request_user_input_async","call_async",1]',
      },
    ])
    expect(answerMutate).not.toHaveBeenCalled()
  })

  it('retires an old async card when the human answers in ordinary chat', async () => {
    await show(meta({ agentKind: 'codex' }), [
      question(),
      ack,
      { id: 'plain-answer', role: 'user', text: 'Use the card header.' },
    ])
    expect(container.querySelector('[data-testid="ask-live"]')).toBeNull()
    expect(optionButtons().every((button) => button.disabled)).toBe(true)
  })

  it('shows a queued reply as readable chat and does not resend it from a remounted card', async () => {
    fakeTrpc.sessions.sendText.mutate.mockResolvedValueOnce({
      ok: true,
      disposition: 'queued',
      position: 1,
    })
    await show(meta({ agentKind: 'codex' }), [question(), ack])
    await act(async () => optionButtons()[0]?.click())
    await flush()
    expect(container.textContent).toContain('queue position 1')
    expect(container.textContent).not.toContain('questionItemId')
    act(() => root.render(<ChatView key="remounted" sessionId={asSessionId('s1')} />))
    await flush()
    await act(async () => reads.at(-1)?.resolve({ items: [question(), ack], hasMore: false }))
    await flush()
    await act(async () => optionButtons()[1]?.click())
    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledTimes(1)
    expect(answerMutate).not.toHaveBeenCalled()
  })

  it('keeps a refused reply in the chat send failure path', async () => {
    fakeTrpc.sessions.sendText.mutate.mockResolvedValueOnce({ ok: false })
    await show(meta({ agentKind: 'codex' }), [question(), ack])
    await act(async () => optionButtons()[0]?.click())
    await flush()
    expect(container.textContent).toContain('not sent')
    await act(async () => optionButtons()[1]?.click())
    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledTimes(1)
    expect(answerMutate).not.toHaveBeenCalled()
  })
})
