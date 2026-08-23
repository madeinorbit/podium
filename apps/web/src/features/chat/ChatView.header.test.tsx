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

/**
 * THE RECLAIMED HEADER (POD-413).
 *
 * Two claims, each of which a future edit could quietly undo:
 *
 *  1. nothing permanent — no search field above a conversation at rest, and the
 *     rail's find button is what puts one there (Esc takes it away, query and
 *     all). ⌘F is NOT that button: it filters the sidebar (POD-1093);
 *  2. the compact dock still gets none of it.
 */

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
    answerAskUserQuestion: { mutate: vi.fn(async () => {}) },
    uploadImage: { mutate: vi.fn(async () => ({ path: '/x' })) },
  },
  messages: { ledger: { query: vi.fn(async (): Promise<unknown> => []) } },
}

let storeSessions: SessionMeta[] = []
let storeIssues: unknown[] = []
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
    issues: storeIssues,
    drafts: {},
    setSessionDraft: vi.fn(),
    resumeAndSend: vi.fn(async () => {}),
    setPanelMode: vi.fn(),
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
    uiState: fakeUiState,
  })
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
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
vi.mock('@/lib/markdown', () => ({
  renderMarkdown: (t: string) => `<p>${t}</p>`,
}))
vi.mock('@/lib/markdown-references', () => ({ isKnownRefPrefix: () => true }))

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
  storeSessions = [meta({})]
  storeIssues = []
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
    await Promise.resolve()
  })
}

/** Mount, resolve the initial read with `items`, and settle. */
async function mount(node: React.ReactElement, items: TranscriptItem[] = []): Promise<void> {
  act(() => {
    root.render(node)
  })
  await act(async () => {
    reads[0]?.resolve({
      items,
      head: items[0]?.cursor,
      tail: items.at(-1)?.cursor,
      hasMore: false,
    })
  })
  await flush()
}

function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

const findInput = (): HTMLInputElement | null => container.querySelector('.chat-find-input')

/** The rail's search button — the only way into find (POD-1093 took ⌘F). */
function clickFind(): void {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Find in transcript"]',
  )
  if (!button) throw new Error('the rail is missing its find button')
  act(() => button.click())
}

describe('the chat header is gone and find is behind the rail button', () => {
  it('renders NO search field until the rail button asks for one', async () => {
    await mount(<ChatView sessionId={asSessionId('s1')} />, [item('a', 'c1', 'hello')])
    expect(findInput()).toBeNull()
    // The reading rail is what survives, and it is a column, not a row.
    expect(container.querySelector('.chat-rail')).not.toBeNull()

    clickFind()
    await flush()
    expect(findInput()).not.toBeNull()
  })

  // The regression this file exists to catch now: ⌘F belongs to the sidebar's
  // task filter, and a transcript bar that still answered it would steal the
  // focus the filter had just taken.
  it('leaves ⌘F and Ctrl-F alone — they are the sidebar filter’s', async () => {
    await mount(<ChatView sessionId={asSessionId('s1')} />, [item('a', 'c1', 'hello')])
    press('f', { metaKey: true })
    press('f', { ctrlKey: true })
    await flush()
    expect(findInput()).toBeNull()
  })

  it('Esc closes it AND clears the query', async () => {
    await mount(<ChatView sessionId={asSessionId('s1')} />, [item('a', 'c1', 'needle in there')])
    clickFind()
    await flush()
    const input = findInput()
    expect(input).not.toBeNull()

    act(() => {
      if (!input) return
      input.value = 'needle'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(findInput()?.value).toBe('needle')

    press('Escape')
    await flush()
    expect(findInput()).toBeNull()

    // Re-opening must not resurrect the old query: a hidden query would keep
    // overriding the reader's verbosity and keep marking the map, invisibly.
    clickFind()
    await flush()
    expect(findInput()?.value).toBe('')
  })

  it('gives the compact dock neither a rail nor a find bar', async () => {
    await mount(<ChatView sessionId={asSessionId('s1')} compact />, [item('a', 'c1', 'hello')])
    expect(container.querySelector('.chat-rail')).toBeNull()
    press('f', { metaKey: true })
    await flush()
    expect(findInput()).toBeNull()
  })
})
