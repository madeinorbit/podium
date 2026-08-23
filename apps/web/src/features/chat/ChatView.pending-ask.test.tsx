import {
  asSessionId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
  type TranscriptItem,
} from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './test-support/client-core-mock'

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
    sendText: { mutate: vi.fn(async () => {}) },
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

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    sessions: storeSessions,
    drafts: {},
    setSessionDraft: vi.fn(),
    resumeAndSend: vi.fn(async () => {}),
    setPanelMode: vi.fn(),
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
  })
  return {
    useStore,
    useReplicaIssues: () => [],
    useSession: (id: string | undefined) =>
      storeSessions.find((session) => session.sessionId === id),
    useSessionDraft: () => '',
    useSessionExitKind: () => undefined,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
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
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
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
