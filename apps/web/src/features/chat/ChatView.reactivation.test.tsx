/**
 * POD-4719 — a warm chat→native→chat toggle must not blank a healthy
 * transcript, and a re-activation must supersede a still-pending first read.
 *
 * The bug: the transcript window dropped its computed graph on every
 * re-activation (`setComputed(null)`), but the worker request is keyed on the
 * held item array — so a re-read resolving the SAME rows never recomputed and
 * the feed stayed blank until genuinely new turns arrived. Separately, the
 * re-activation re-read was skipped entirely while the first read was still
 * pending, holding every heal closed until the stale read resolved.
 */
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

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void

interface ReadCall {
  input: { sessionId: SessionId; anchor?: string; direction: 'before' | 'after'; limit: number }
  resolve: (r: { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }) => void
}

const fakeHub = {
  subscribes: [] as Array<{ sessionId: SessionId; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: SessionId, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
}

const reads: ReadCall[] = []
const fakeTrpc = {
  sessions: {
    transcriptRead: {
      query(input: ReadCall['input']) {
        return new Promise((resolve) => {
          reads.push({ input, resolve })
        })
      },
    },
    sendText: { mutate: vi.fn(async () => ({ disposition: 'delivered' })) },
    interrupt: { mutate: vi.fn(async () => ({ ok: true })) },
    answerAskUserQuestion: { mutate: vi.fn(async () => {}) },
    uploadImage: { mutate: vi.fn(async () => ({ path: '/x' })) },
  },
  messages: {
    ledger: { query: vi.fn(async (): Promise<unknown> => []) },
    cancel: { mutate: vi.fn(async () => ({ status: 'cancelled' })) },
  },
}

const storeActions = {
  resumeAndSend: vi.fn(async (_sessionId: SessionId, _text: string) => {}),
  setPanelMode: vi.fn((_sessionId: SessionId, _mode: 'chat' | 'native') => {}),
  setSessionDraft: vi.fn(),
}

let storeSessions: SessionMeta[] = []
let storeDrafts: Record<string, string> = {}
const fakeUiValues = new Map<string, string>()
const fakeUiListeners = new Set<() => void>()
const fakeUiState = {
  get: (key: string) => fakeUiValues.get(key) ?? null,
  set: (key: string, value: string | null) => {
    if (value === null) fakeUiValues.delete(key)
    else fakeUiValues.set(key, value)
    for (const listener of fakeUiListeners) listener()
  },
  subscribe: (listener: () => void) => {
    fakeUiListeners.add(listener)
    return () => fakeUiListeners.delete(listener)
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

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    sessions: storeSessions,
    drafts: storeDrafts,
    setSessionDraft: storeActions.setSessionDraft,
    resumeAndSend: storeActions.resumeAndSend,
    // The outbox chat send actions (POD-4762); these tests never send.
    sendChat: vi.fn(async () => ({ state: 'sent' as const })),
    chatSendsFor: () => [],
    discardChat: vi.fn(async () => {}),
    setPanelMode: storeActions.setPanelMode,
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
    uiState: fakeUiState,
  })
  return {
    useStore,
    useReplicaIssues: () => [],
    useSession: (id: string | undefined) =>
      storeSessions.find((session) => session.sessionId === id),
    useSessionDraft: (id: string | undefined) => (id === undefined ? '' : (storeDrafts[id] ?? '')),
    useSessionExitKind: () => undefined,
    useRuntimeSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('@/lib/markdown', () => ({
  renderMarkdown: (t: string) => `<p>${t}</p>`,
}))
vi.mock(import('@/lib/markdown-references'), async (importOriginal) => ({
  ...(await importOriginal()),
  isKnownRefPrefix: () => true,
}))

const { ChatView } = await import('./ChatView')

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

function turn(id: string, cursor: string, role: 'user' | 'assistant', text: string): TranscriptItem {
  return { id, cursor, role, text }
}

const BOUND_TURNS = (): TranscriptItem[] => [
  turn('u-1', 'c-u1', 'user', 'BOUND_PROMPT_ALPHA please refactor the parser'),
  turn('a-1', 'c-a1', 'assistant', 'BOUND_ANSWER_BRAVO done'),
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  fakeHub.subscribes.length = 0
  storeSessions = [meta({})]
  storeDrafts = {}
  fakeUiValues.clear()
  fakeUiListeners.clear()
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
    await vi.dynamicImportSettled()
    await Promise.resolve()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}

function markersPresent(): boolean {
  const text = container.textContent ?? ''
  return (
    text.includes('BOUND_PROMPT_ALPHA please refactor the parser') &&
    text.includes('BOUND_ANSWER_BRAVO done')
  )
}

describe('POD-4719 warm re-activation keeps the transcript', () => {
  it('a same-content re-read after a warm toggle does not blank rendered turns', async () => {
    act(() => {
      root.render(
        <ChatView sessionId={asSessionId('s1')} active={true} deferInitialTranscript={false} />,
      )
    })
    await flush()
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.resolve({ items: BOUND_TURNS(), head: 'c-u1', tail: 'c-a1', hasMore: false })
    })
    await flush()
    expect(markersPresent()).toBe(true)

    // Native tab: the view stays mounted but goes inactive/deferred.
    act(() => {
      root.render(
        <ChatView sessionId={asSessionId('s1')} active={false} deferInitialTranscript={true} />,
      )
    })
    await flush()

    // Back to chat: the re-read resolves the SAME rows (fresh objects, same
    // identity). The previously rendered turns must stay on screen — before
    // the fix the dropped graph never recomputed and the feed went blank.
    act(() => {
      root.render(
        <ChatView sessionId={asSessionId('s1')} active={true} deferInitialTranscript={false} />,
      )
    })
    await flush()
    expect(reads.length).toBeGreaterThanOrEqual(2)
    await act(async () => {
      reads[reads.length - 1]?.resolve({
        items: BOUND_TURNS(),
        head: 'c-u1',
        tail: 'c-a1',
        hasMore: false,
      })
    })
    await flush()
    expect(markersPresent()).toBe(true)
    expect(container.querySelector('[data-testid="transcript-empty-state"]')).toBeNull()
  })

  it('a re-activation supersedes a still-pending first read', async () => {
    // Mount active with the first read LEFT PENDING (slow daemon legs).
    act(() => {
      root.render(
        <ChatView sessionId={asSessionId('s1')} active={true} deferInitialTranscript={false} />,
      )
    })
    await flush()
    expect(reads).toHaveLength(1)

    // Pane switch away and back while the first read is still pending. The
    // re-activation must issue a fresh read rather than wait out the stale one.
    act(() => {
      root.render(
        <ChatView sessionId={asSessionId('s1')} active={false} deferInitialTranscript={false} />,
      )
    })
    await flush()
    act(() => {
      root.render(
        <ChatView sessionId={asSessionId('s1')} active={true} deferInitialTranscript={false} />,
      )
    })
    await flush()
    expect(reads.length).toBeGreaterThanOrEqual(2)

    await act(async () => {
      reads[reads.length - 1]?.resolve({
        items: BOUND_TURNS(),
        head: 'c-u1',
        tail: 'c-a1',
        hasMore: false,
      })
    })
    await flush()
    expect(markersPresent()).toBe(true)
  })
})
