import type { SessionMeta, TranscriptItem } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// A controllable fake hub + tRPC, injected via the store mock. The hub records
// the (sessionId, since, cb) of each subscribeTranscript call so a test can push
// deltas (or none) and assert what renders.
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void

interface ReadCall {
  input: { sessionId: string; anchor?: string; direction: 'before' | 'after'; limit: number }
  resolve: (r: { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }) => void
}

const fakeHub = {
  subscribes: [] as Array<{ sessionId: string; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: string, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
  // ChatView calls these on the hub indirectly via SessionConnection only in
  // native mode; the chat path doesn't, so stubs suffice.
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
    sendText: { mutate: vi.fn(async () => {}) },
    answerAskUserQuestion: { mutate: vi.fn(async () => {}) },
    uploadImage: { mutate: vi.fn(async () => ({ path: '/x' })) },
  },
}

let storeSessions: SessionMeta[] = []

// Inert replica stub — the offline-copy path has its own suite (ChatView.offline.test.tsx).
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

vi.mock('./store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    sessions: storeSessions,
    drafts: {},
    setSessionDraft: vi.fn(),
    resumeAndSend: vi.fn(async () => {}),
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

// Voice + markdown touch browser APIs that are flaky under happy-dom — stub them.
vi.mock('./voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('./markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))

const { ChatView } = await import('./ChatView')

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's1',
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
  }
}

function item(id: string, cursor: string, text: string): TranscriptItem {
  return { id, cursor, role: 'assistant', text }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  fakeHub.subscribes.length = 0
  storeSessions = [meta({})]
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
  // Let pending microtasks (the awaited tRPC query) settle inside act.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ChatView read-then-subscribe', () => {
  it('renders a LIVE session transcript from the initial read even with ZERO hub deltas', async () => {
    act(() => {
      root.render(<ChatView sessionId="s1" />)
    })
    // The read-then-subscribe effect fires a transcriptRead.
    expect(reads).toHaveLength(1)
    expect(reads[0]?.input).toMatchObject({ sessionId: 's1', direction: 'before' })
    // Resolve it with a window — and push NO hub deltas.
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'hello from read'), item('b', 'c2', 'world')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    // The regression: items render purely from the read, no live stream needed.
    expect(container.textContent).toContain('hello from read')
    expect(container.textContent).toContain('world')
    // And the live subscribe used the read's tail as `since`.
    expect(fakeHub.subscribes).toHaveLength(1)
    expect(fakeHub.subscribes[0]).toMatchObject({ sessionId: 's1', since: 'c2' })
  })

  it('merges a live delta without duplicating an item already in the read window', async () => {
    act(() => {
      root.render(<ChatView sessionId="s1" />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'first'), item('b', 'c2', 'second')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    const cb = fakeHub.subscribes[0]?.cb
    // A live delta that REPEATS the last read item (c2) plus a genuinely new one.
    await act(async () => {
      cb?.([item('b', 'c2', 'second'), item('c', 'c3', 'third')], { reset: false })
    })
    await flush()
    expect(container.textContent).toContain('third')
    // 'second' must appear exactly once (no duplicate from the overlapping delta).
    const occurrences = container.textContent?.split('second').length ?? 0
    expect(occurrences - 1).toBe(1)
  })

  it('re-reads the window when a reset delta arrives', async () => {
    act(() => {
      root.render(<ChatView sessionId="s1" />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'old content')],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    expect(reads).toHaveLength(1)
    const cb = fakeHub.subscribes[0]?.cb
    await act(async () => {
      cb?.([], { reset: true })
    })
    // A reset triggers a fresh read.
    expect(reads).toHaveLength(2)
    await act(async () => {
      reads[1]?.resolve({
        items: [item('z', 'c9', 'fresh content')],
        head: 'c9',
        tail: 'c9',
        hasMore: false,
      })
    })
    await flush()
    expect(container.textContent).toContain('fresh content')
  })

  it('shows "No transcript yet" when the read resolves empty', async () => {
    act(() => {
      root.render(<ChatView sessionId="s1" />)
    })
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()
    expect(container.textContent).toContain('No transcript yet')
  })

  it('does a read-then-subscribe for a PARKED (hibernated) session too — no parked gate', async () => {
    storeSessions = [meta({ status: 'hibernated' })]
    act(() => {
      root.render(<ChatView sessionId="s1" />)
    })
    // Same uniform path: an initial read, then a subscribe — no separate parked fetch.
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.resolve({
        items: [item('p', 'cp', 'parked history')],
        head: 'cp',
        tail: 'cp',
        hasMore: false,
      })
    })
    await flush()
    expect(container.textContent).toContain('parked history')
    expect(fakeHub.subscribes).toHaveLength(1)
  })
})
