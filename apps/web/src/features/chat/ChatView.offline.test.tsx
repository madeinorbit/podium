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

// ---------------------------------------------------------------------------
// ChatView offline-copy path (docs/spec/thin-client-replica.md §2.3): a failed
// transcript read serves the replica's cached window with the "offline copy"
// notice; a successful read writes through into the replica and clears it.
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void

const fakeHub = {
  subscribes: [] as Array<{ sessionId: SessionId; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: SessionId, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
}

interface ReadCall {
  input: { sessionId: SessionId; anchor?: string; direction: 'before' | 'after'; limit: number }
  resolve: (r: { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }) => void
  reject: (err: unknown) => void
}

const reads: ReadCall[] = []
const fakeTrpc = {
  sessions: {
    transcriptRead: {
      query(input: ReadCall['input']) {
        return new Promise((resolve, reject) => {
          reads.push({ input, resolve, reject })
        })
      },
    },
    sendText: { mutate: vi.fn(async () => {}) },
    answerAskUserQuestion: { mutate: vi.fn(async () => {}) },
    uploadImage: { mutate: vi.fn(async () => ({ path: '/x' })) },
  },
}

/** Recording replica fake: cached windows served by key + a log of write-throughs. */
const fakeReplica = {
  available: true,
  windows: new Map<string, { items: TranscriptItem[]; savedAt: number }>(),
  puts: [] as Array<{ key: string; items: TranscriptItem[] }>,
  hydrate: async () => ({ sessions: [], issues: [], conversations: [], cursor: null }),
  applySnapshot: () => {},
  applyChanges: () => {},
  getCursor: () => null,
  setCursor: () => {},
  transcriptWindow(key: string) {
    return this.windows.get(key)
  },
  putTranscriptWindow(key: string, items: TranscriptItem[]) {
    this.puts.push({ key, items })
    this.windows.set(key, { items, savedAt: Date.now() })
  },
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
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('@/lib/markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))

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

function item(id: string, cursor: string, text: string): TranscriptItem {
  return { id, cursor, role: 'assistant', text }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  fakeHub.subscribes.length = 0
  fakeReplica.windows.clear()
  fakeReplica.puts.length = 0
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
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ChatView offline transcript copy', () => {
  it('serves the cached window with the offline-copy notice when the read fails', async () => {
    fakeReplica.windows.set('s1', {
      items: [item('a', 'c1', 'cached hello'), item('b', 'c2', 'cached world')],
      savedAt: Date.parse('2026-07-01T10:00:00.000Z'),
    })
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.reject(new Error('fetch failed'))
    })
    await flush()
    expect(container.textContent).toContain('cached hello')
    expect(container.textContent).toContain('cached world')
    const notice = container.querySelector('[data-notice="offline"]')
    expect(notice?.textContent).toContain('Offline copy')
    expect(notice?.textContent).toContain('as of')
  })

  it('settles to the empty state (no notice) on a failed read with no cache', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.reject(new Error('fetch failed'))
    })
    await flush()
    expect(container.querySelector('[data-notice="offline"]')).toBeNull()
    expect(container.querySelector('[data-testid="transcript-empty-state"]')).not.toBeNull()
  })

  it('writes a successful read through into the replica and shows no notice', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'live one'), item('b', 'c2', 'live two')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    expect(container.textContent).toContain('live one')
    expect(container.querySelector('[data-notice="offline"]')).toBeNull()
    expect(fakeReplica.puts).toHaveLength(1)
    expect(fakeReplica.puts[0]?.key).toBe('s1')
    expect(fakeReplica.puts[0]?.items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('a later successful read clears the offline-copy notice', async () => {
    fakeReplica.windows.set('s1', {
      items: [item('a', 'c1', 'stale cached')],
      savedAt: Date.now(),
    })
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} active={false} />)
    })
    await act(async () => {
      reads[0]?.reject(new Error('offline'))
    })
    await flush()
    expect(container.querySelector('[data-notice="offline"]')).not.toBeNull()
    // Becoming active triggers a re-read (the becameActive refresh) — succeed it.
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} active={true} />)
    })
    await flush()
    expect(reads.length).toBeGreaterThanOrEqual(2)
    await act(async () => {
      reads.at(-1)?.resolve({
        items: [item('z', 'c9', 'fresh from server')],
        head: 'c9',
        tail: 'c9',
        hasMore: false,
      })
    })
    await flush()
    expect(container.textContent).toContain('fresh from server')
    expect(container.querySelector('[data-notice="offline"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// CACHE-FIRST (POD-700). The same cached window the offline path falls back to
// is also the fastest thing this pane can paint when the server IS reachable:
// the read costs p50 545ms and up to 8.7s on a cold panel open, and the pane
// used to hold nothing for all of it. Seeding is a first-frame paint, not a
// fallback, so it must not borrow any of the offline path's other claims.
// ---------------------------------------------------------------------------
describe('ChatView cache-first transcript', () => {
  it('paints the cached window before the read resolves, with no offline notice', async () => {
    fakeReplica.windows.set('s1', {
      items: [item('a', 'c1', 'cached hello')],
      savedAt: Date.parse('2026-07-01T10:00:00.000Z'),
    })
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    // The read is in flight and has answered nothing yet.
    expect(reads).toHaveLength(1)
    expect(container.textContent).toContain('cached hello')
    // Not the offline path: the server was never unreachable, so no notice.
    expect(container.querySelector('[data-notice="offline"]')).toBeNull()
    // And not the cold state either — there is real content on screen.
    expect(container.querySelector('[data-testid="transcript-cold"]')).toBeNull()
  })

  it('lets the read reconcile the seed rather than replacing the pane', async () => {
    fakeReplica.windows.set('s1', {
      items: [item('a', 'c1', 'cached hello')],
      savedAt: Date.now(),
    })
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'cached hello'), item('b', 'c2', 'newer turn')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    // The seed is not duplicated by the read that supersedes it.
    expect(container.textContent).toContain('newer turn')
    expect(container.textContent?.match(/cached hello/g)).toHaveLength(1)
  })

  it('shows the cold transcript when the session has never been read here', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    expect(container.querySelector('[data-testid="transcript-cold"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="transcript-empty-state"]')).toBeNull()
  })

  // The cache answers "what did we read last time", never "does this conversation
  // have anything in it" — only the read settles that. A seeded pane whose read
  // comes back empty must still be able to reach the terminal empty state.
  it('leaves the empty answer to the read, not to the cache', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()
    expect(container.querySelector('[data-testid="transcript-empty-state"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="transcript-cold"]')).toBeNull()
  })

  // Back-paging needs an anchor, and the anchor arrives with the read. A seeded
  // pane must not offer a page it would refuse to fetch.
  it('offers no earlier-transcript pager until the read supplies an anchor', async () => {
    fakeReplica.windows.set('s1', {
      items: [item('a', 'c1', 'cached hello')],
      savedAt: Date.now(),
    })
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    expect(container.textContent).toContain('cached hello')
    expect(container.querySelector('.transcript-pager')).toBeNull()
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'cached hello')],
        head: 'c1',
        tail: 'c1',
        hasMore: true,
      })
    })
    await flush()
    // With an anchor in hand it is a real affordance again.
    expect(container.querySelector('.transcript-pager')).not.toBeNull()
  })

  // A seeded window has no live subscription behind it, so re-activating a pane
  // that only ever painted from cache must still go to the server.
  it('does not let a seeded window stand in for a re-read on re-activation', async () => {
    fakeReplica.windows.set('s1', {
      items: [item('a', 'c1', 'cached hello')],
      savedAt: Date.now(),
    })
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} active={false} />)
    })
    await act(async () => {
      reads[0]?.reject(new Error('still starting up'))
    })
    await flush()
    const before = reads.length
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} active={true} />)
    })
    await flush()
    expect(reads.length).toBeGreaterThan(before)
  })
})
