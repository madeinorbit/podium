import {
  asMachineId,
  asSessionId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
  type TranscriptItem,
} from '@podium/model'
import { waitFor } from '@testing-library/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './test-support/client-core-mock'

// ---------------------------------------------------------------------------
// POD-4808: offline machine chat shows nothing / looks live.
// Half 1: old HIBERNATED session on OFFLINE machine returns an empty page with
// no explanation — the server ran the offline branch (no daemon → lake over
// mirrored bytes → undefined when nothing was mirrored) and returned
// {items:[], hasMore:false}, which the client treats as done (empty phase).
// The chat must instead say WHY via the server's offline flag:
// "machine '<name>' is offline — history will load when it reconnects".
// Half 2 (review): the 'machine is offline' banner comes from the client's
// LIVE machine presence (session.machineId -> store machines' online), NOT
// from the flag frozen into the last transcript read — so it appears when the
// machine drops and clears when it returns without any re-read.
// Reconnect: when the machine comes back online the chat re-reads history and
// replaces the offline message (no reload).
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
  resolve: (r: {
    items: TranscriptItem[]
    head?: string
    tail?: string
    hasMore: boolean
    offline?: { machineName: string }
  }) => void
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
let storeMachines: Array<{ id: string; name: string; online: boolean; availability?: { daemon: boolean } }> = []

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    sessions: storeSessions,
    machines: storeMachines,
    drafts: {},
    setSessionDraft: vi.fn(),
    resumeAndSend: vi.fn(async () => {}),
    // The outbox chat send actions (POD-4762); these tests never send.
    sendChat: vi.fn(async () => ({ state: 'sent' as const })),
    chatSendsFor: () => [],
    discardChat: vi.fn(async () => {}),
    setPanelMode: vi.fn(),
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  fakeHub.subscribes.length = 0
  fakeReplica.windows.clear()
  fakeReplica.puts.length = 0
  storeSessions = [meta({})]
  storeMachines = []
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

describe('ChatView machine-offline history (POD-4808)', () => {
  it('half 1: hibernated session on an offline machine says why history is missing instead of an empty pane', async () => {
    storeSessions = [
      meta({ status: 'hibernated', machineId: asMachineId('m1'), machineName: 'desk' }),
    ]
    storeMachines = [{ id: 'm1', name: 'desk', online: false }]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false, offline: { machineName: 'desk' } })
    })
    await flush()
    await waitFor(() => expect(container.querySelector('[data-testid="transcript-machine-offline"]')).not.toBeNull())
    const marker = container.querySelector('[data-testid="transcript-machine-offline"]')
    expect(marker?.textContent).toContain('desk')
    expect(marker?.textContent?.toLowerCase()).toContain('offline')
    expect(marker?.textContent?.toLowerCase()).toContain('reconnect')
  })

  it('half 2: live banner comes from live machine presence, not the frozen transcript flag', async () => {
    storeSessions = [
      meta({
        status: 'live',
        machineId: asMachineId('m1'),
        machineName: 'desk',
        agentState: {
          phase: 'working',
          since: new Date(Date.now() - 149_380).toISOString(),
          nativeSubagentCount: 0,
        },
      }),
    ]
    storeMachines = [{ id: 'm1', name: 'desk', online: false }]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    expect(reads).toHaveLength(1)
    // NOTE: no offline flag on the transcript page — the banner must still
    // show, because it reads live presence (session.machineId -> machines).
    await act(async () => {
      reads[0]?.resolve({
        items: [
          {
            id: 'tool-1',
            cursor: 'c1',
            role: 'tool',
            text: '',
            toolName: 'Bash',
            toolInput: 'bun test',
            ts: new Date(Date.now() - 149_380).toISOString(),
          } as TranscriptItem,
        ],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    await waitFor(() => expect(container.textContent).toContain('Waiting on shell'))
    const marker = container.querySelector('[data-testid="transcript-machine-offline"]')
    expect(marker).not.toBeNull()
    expect(marker?.textContent).toContain('desk')
    expect(marker?.textContent?.toLowerCase()).toContain('offline')
    // Machine comes back online: the banner clears from live presence alone —
    // no transcript re-read is needed for the clear (a reconnect re-read may
    // still be in flight behind it; the banner must already be gone).
    storeMachines = [{ id: 'm1', name: 'desk', online: true }]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()
    await waitFor(() =>
      expect(container.querySelector('[data-testid="transcript-machine-offline"]')).toBeNull(),
    )
  })

  it('POD-4830: supervised daemon loss (online true, degraded) still shows the live banner', async () => {
    storeSessions = [
      meta({
        status: 'live',
        machineId: asMachineId('m1'),
        machineName: 'desk',
        agentState: {
          phase: 'working',
          since: new Date(Date.now() - 149_380).toISOString(),
          nativeSubagentCount: 0,
        },
      }),
    ]
    // The server keeps `online` true (degraded) while the daemon is gone —
    // the banner must read the daemon too, or a frozen daemon never shows.
    storeMachines = [{ id: 'm1', name: 'desk', online: true, availability: { daemon: false } }]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.resolve({
        items: [
          {
            id: 'tool-1',
            cursor: 'c1',
            role: 'tool',
            text: '',
            toolName: 'Bash',
            toolInput: 'bun test',
            ts: new Date(Date.now() - 149_380).toISOString(),
          } as TranscriptItem,
        ],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    await waitFor(() => expect(container.textContent).toContain('Waiting on shell'))
    const marker = container.querySelector('[data-testid="transcript-machine-offline"]')
    expect(marker).not.toBeNull()
    expect(marker?.textContent).toContain('desk')
    // Daemon reattaches: the banner clears from live presence alone.
    storeMachines = [{ id: 'm1', name: 'desk', online: true, availability: { daemon: true } }]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()
    await waitFor(() =>
      expect(container.querySelector('[data-testid="transcript-machine-offline"]')).toBeNull(),
    )
  })

  it('reconnect re-reads history and replaces the offline message without a reload', async () => {
    storeSessions = [
      meta({ status: 'hibernated', machineId: asMachineId('m1'), machineName: 'desk' }),
    ]
    storeMachines = [{ id: 'm1', name: 'desk', online: false }]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false, offline: { machineName: 'desk' } })
    })
    await flush()
    await waitFor(() => expect(container.querySelector('[data-testid="transcript-machine-offline"]')).not.toBeNull())
    // Machine reconnects: the chat re-reads and the offline message is
    // replaced by history — no reload.
    storeMachines = [{ id: 'm1', name: 'desk', online: true }]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()
    await waitFor(() => expect(reads.length).toBe(2))
    await act(async () => {
      reads[1]?.resolve({
        items: [{ id: 'a', cursor: 'c1', role: 'assistant', text: 'reconnected history' }],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    await waitFor(() => expect(container.textContent).toContain('reconnected history'))
    expect(container.querySelector('[data-testid="transcript-machine-offline"]')).toBeNull()
  })
})
