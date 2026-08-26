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
 * DRAGGING A FILE AT THE CONVERSATION (POD-1595).
 *
 * The drop handlers used to be mounted on the composer dock alone — a strip
 * about seventy pixels tall at the bottom of the pane — so a file released over
 * the transcript, which is what "drop it into the chat" actually looks like,
 * did nothing at all. They are mounted on the whole chat surface now, and these
 * pin the two halves that matter: the transcript accepts a drop, and it is
 * accepted exactly ONCE (mounting the handlers in two places would have
 * attached every file twice, which no screen would have shown).
 *
 * NOTE ON THE EXTRA MOCK, AND WHEN TO DELETE IT. `use-chat-surface` takes
 * `useStoreHandle` straight from `@podium/client-core/react` rather than through
 * the `@/app/store` seam this file mocks, so the real provider is required and
 * throws. The sibling ChatView suites no longer need a stub for it — whatever
 * repaired them landed on main separately — but this one still does: remove the
 * mock below and all three tests fail at first render. Checked, not assumed.
 *
 * POD-1614 is repairing the seam properly (`store.tsx` re-exports a Trpc-typed
 * `useStoreHandle`; `use-chat-surface` imports it from `@/app/store`). That has
 * NOT landed here yet — `use-chat-surface.ts:1` still imports from the package.
 * The moment it does, delete the mock: a stub held over a seam that no longer
 * leaks is how a suite starts testing its own scaffolding.
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
  isKnownRefPrefix: () => true,
}))

vi.mock('@podium/client-core/react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    // See the note above: the only member this view takes off the module
    // directly, and the one the app-store mock therefore cannot cover.
    useStoreHandle: () => ({ getSnapshot: () => ({ issues: [] }) }),
  }
})

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

/** FileReader's onload is a macrotask, so microtask flushes are not enough to
 *  see an upload land — and a half-settled drop leaking into the next test is
 *  exactly how a suite starts lying about which drop uploaded what. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(): Promise<void> {
  act(() => {
    root.render(<ChatView sessionId={asSessionId('s1')} />)
  })
  await act(async () => {
    reads[0]?.resolve({ items: [], hasMore: false })
  })
  // The feed is a lazy import; let its Suspense boundary resolve so the drop
  // lands on the real transcript rather than on a fallback.
  await settle()
}

/** A DataTransfer carrying one file, honest about `kind` — the field the
 *  composer decides by, and the only one available during `dragover`. */
function transfer(): DataTransfer {
  const file = new File(['%PDF-1.4'], 'spec.pdf', { type: 'application/pdf' })
  const list = Object.assign([{ kind: 'file', type: file.type, getAsFile: () => file }], {
    length: 1,
  })
  return { items: list, files: [file], types: ['Files'] } as unknown as DataTransfer
}

/** Fire a React drag event at `el`. happy-dom builds no DragEvent, so the
 *  dataTransfer rides on a plain bubbling Event, which is what React reads. */
function drag(el: Element, type: 'dragover' | 'drop'): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer() })
  act(() => {
    el.dispatchEvent(event)
  })
}

describe('ChatView file drop', () => {
  /** Deep inside the transcript — the end of the feed, as far from the composer
   *  dock as anything the operator can aim at. */
  const inTranscript = (): Element => {
    const el =
      container.querySelector('[data-testid="feed-tail-slot"]') ??
      container.querySelector('.offer-lift-region')
    if (el === null) throw new Error('no transcript to drop on')
    return el
  }

  it('offers the target when a file is dragged over the TRANSCRIPT, not just the dock', async () => {
    await mount()
    expect(container.querySelector('[data-testid="composer-drop-target"]')).toBeNull()
    drag(inTranscript(), 'dragover')
    expect(container.querySelector('[data-testid="composer-drop-target"]')).not.toBeNull()
  })

  it('uploads a file dropped on the transcript', async () => {
    await mount()
    drag(inTranscript(), 'dragover')
    drag(inTranscript(), 'drop')
    await settle()
    expect(fakeTrpc.sessions.uploadImage.mutate).toHaveBeenCalledTimes(1)
    expect(fakeTrpc.sessions.uploadImage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'spec.pdf' }),
    )
    // And the target goes away with the drag that ended.
    expect(container.querySelector('[data-testid="composer-drop-target"]')).toBeNull()
  })

  it('attaches a file dropped on the COMPOSER exactly once', async () => {
    await mount()
    const textarea = container.querySelector('textarea')
    if (textarea === null) throw new Error('no composer field')
    // The drop bubbles from the field, through the dock, to the surface. Only
    // one mount may act on it — two would upload the same file twice.
    drag(textarea, 'drop')
    await settle()
    expect(fakeTrpc.sessions.uploadImage.mutate).toHaveBeenCalledTimes(1)
  })
})
