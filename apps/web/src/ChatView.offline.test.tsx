import type { SessionMeta, TranscriptItem } from '@podium/protocol'
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
  subscribes: [] as Array<{ sessionId: string; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: string, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
}

interface ReadCall {
  input: { sessionId: string; anchor?: string; direction: 'before' | 'after'; limit: number }
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
      root.render(<ChatView sessionId="s1" />)
    })
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.reject(new Error('fetch failed'))
    })
    await flush()
    expect(container.textContent).toContain('cached hello')
    expect(container.textContent).toContain('cached world')
    expect(container.textContent).toContain('offline copy — as of')
  })

  it('settles to the empty state (no notice) on a failed read with no cache', async () => {
    act(() => {
      root.render(<ChatView sessionId="s1" />)
    })
    await act(async () => {
      reads[0]?.reject(new Error('fetch failed'))
    })
    await flush()
    expect(container.textContent).not.toContain('offline copy')
    expect(container.textContent).toContain('No transcript yet')
  })

  it('writes a successful read through into the replica and shows no notice', async () => {
    act(() => {
      root.render(<ChatView sessionId="s1" />)
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
    expect(container.textContent).not.toContain('offline copy')
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
      root.render(<ChatView sessionId="s1" active={false} />)
    })
    await act(async () => {
      reads[0]?.reject(new Error('offline'))
    })
    await flush()
    expect(container.textContent).toContain('offline copy')
    // Becoming active triggers a re-read (the becameActive refresh) — succeed it.
    act(() => {
      root.render(<ChatView sessionId="s1" active={true} />)
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
    expect(container.textContent).not.toContain('offline copy')
  })
})
