import type { IssueWire, SessionMeta, SyncChangesSinceResult } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReplica } from './replica'
import { makeIssue } from './test-issue'

// ---------------------------------------------------------------------------
// Store ↔ replica wiring (docs/spec/thin-client-replica.md §2.2): hydrate-first
// paint (a seeded replica populates store state BEFORE any hub/network event),
// cursor resume (the persisted cursor rides into the first changesSince), and
// reconcile-on-snapshot (server truth replaces the seed once it answers).
// The real StoreProvider + SocketHub + replica run; only tRPC and the browser
// WebSocket are faked.
// ---------------------------------------------------------------------------

const changesSinceCalls: Array<number | null> = []
let changesSinceResolve: ((r: SyncChangesSinceResult) => void) | undefined

const fakeTrpc = {
  sync: {
    changesSince: {
      query: ({ cursor }: { cursor: number | null }) => {
        changesSinceCalls.push(cursor)
        return new Promise<SyncChangesSinceResult>((resolve) => {
          changesSinceResolve = resolve
        })
      },
    },
  },
  discovery: {
    refreshRepos: { mutate: async () => ({ repositories: [], diagnostics: [] }) },
  },
  pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
  tabs: { listOrders: { query: async () => ({}) } },
  settings: { get: { query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } }) } },
  sessions: {
    rename: { mutate: async () => ({}) },
    markRead: { mutate: async () => ({}) },
  },
  issues: { markRead: { mutate: async () => ({}) } },
}

vi.mock('./trpc', () => ({ makeTrpc: () => fakeTrpc }))

const { StoreProvider, useStore } = await import('./store')

/** Captured WebSocket fakes, in construction order — the test opens/drives them. */
const sockets: FakeWS[] = []
class FakeWS {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(_url: string) {
    sockets.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
}

function session(id: string, title = id): SessionMeta {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    title,
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
  }
}

let latest: { sessions: SessionMeta[]; issues: IssueWire[] } = { sessions: [], issues: [] }
let latestStore: ReturnType<typeof useStore> | null = null
function Probe(): null {
  const store = useStore()
  latest = { sessions: store.sessions, issues: store.issues }
  latestStore = store
  return null
}

let container: HTMLDivElement
let root: Root
let realWS: typeof WebSocket

beforeEach(() => {
  localStorage.clear()
  changesSinceCalls.length = 0
  changesSinceResolve = undefined
  sockets.length = 0
  latest = { sessions: [], issues: [] }
  latestStore = null
  realWS = globalThis.WebSocket
  globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.WebSocket = realWS
  vi.restoreAllMocks()
})

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })

function render(): void {
  act(() => {
    root.render(
      <StoreProvider
        config={{ httpOrigin: 'http://x', wsClientUrl: 'ws://x' }}
        onFatalError={() => {}}
      >
        <Probe />
      </StoreProvider>,
    )
  })
}

describe('store ↔ replica', () => {
  it('hydrate-first: a seeded replica paints store state before any hub event, then the snapshot reconciles', async () => {
    // Persist a replica as a previous session of the app would have.
    const previous = createReplica()
    previous.applySnapshot('sessions', [session('s-local', 'from replica')])
    previous.setCursor(7)
    await settle()

    render()
    await settle()
    // The hub never connected (socket not opened) — state came from the replica.
    expect(latest.sessions.map((s) => s.title)).toEqual(['from replica'])

    // Now the network answers: open the socket; the heal passes the persisted
    // cursor (resume-across-reloads) and its snapshot replaces the seed.
    act(() => sockets[0]?.onopen?.({}))
    await settle()
    expect(changesSinceCalls).toEqual([7])
    changesSinceResolve?.({
      kind: 'snapshot',
      sessions: [session('s-server', 'from server')],
      issues: [],
      conversations: [],
      diagnostics: [],
      cursor: 9,
    })
    await settle()
    expect(latest.sessions.map((s) => s.title)).toEqual(['from server'])

    // And the applied snapshot persisted back into the replica (data + cursor).
    const reread = createReplica()
    const h = await reread.hydrate()
    expect(h.sessions.map((s) => s.title)).toEqual(['from server'])
    expect(h.cursor).toBe(9)
  })

  it('cold client: no replica → first changesSince uses null and nothing is seeded', async () => {
    render()
    await settle()
    expect(latest.sessions).toEqual([])
    act(() => sockets[0]?.onopen?.({}))
    await settle()
    expect(changesSinceCalls).toEqual([null])
  })

  it('optimistic write in live-query mode: renameSession patches the replica and the list re-renders', async () => {
    const previous = createReplica()
    previous.applySnapshot('sessions', [session('s1', 't1')])
    previous.setCursor(3)
    await settle()

    render()
    await settle()
    expect(latest.sessions).toHaveLength(1)
    expect(latest.sessions[0]?.name).toBeUndefined()

    // Optimistic curation write: no server involved (the round-trip rides the
    // outbox) — the live query must re-render with the patched row, and the
    // patch must persist (an offline reload keeps the optimistic value).
    await act(async () => {
      await latestStore?.renameSession('s1', ' renamed ')
    })
    await settle()
    expect(latest.sessions[0]?.name).toBe('renamed')
    const reread = createReplica()
    const h = await reread.hydrate()
    expect(h.sessions[0]?.name).toBe('renamed')
  })

  // Unread foundation (issue #124): markSessionRead / markIssueRead optimistically
  // patch readAt + unread (the round-trip rides the outbox) and the patch persists.
  it('markSessionRead optimistically clears unread and persists', async () => {
    const previous = createReplica()
    previous.applySnapshot('sessions', [{ ...session('s1'), unread: true, readAt: null }])
    previous.setCursor(3)
    await settle()

    render()
    await settle()
    expect(latest.sessions[0]?.unread).toBe(true)

    await act(async () => {
      await latestStore?.markSessionRead('s1')
    })
    await settle()
    expect(latest.sessions[0]?.unread).toBe(false)
    expect(latest.sessions[0]?.readAt).not.toBeNull()
    const reread = createReplica()
    const h = await reread.hydrate()
    expect(h.sessions[0]?.unread).toBe(false)
  })

  it('markIssueRead optimistically clears unread and persists', async () => {
    const previous = createReplica()
    previous.applySnapshot('issues', [makeIssue({ id: 'iss_1', unread: true, readAt: null })])
    previous.setCursor(3)
    await settle()

    render()
    await settle()
    expect(latest.issues[0]?.unread).toBe(true)

    await act(async () => {
      await latestStore?.markIssueRead('iss_1')
    })
    await settle()
    expect(latest.issues[0]?.unread).toBe(false)
    expect(latest.issues[0]?.readAt).not.toBeNull()
    const reread = createReplica()
    const h = await reread.hydrate()
    expect(h.issues[0]?.unread).toBe(false)
  })

  it('replica non-persistent (private browsing): the SAME replica path carries sessions in memory', async () => {
    // Make the replica's persistence probe fail while leaving every other
    // localStorage key usable — the private-mode degradation contract. There is
    // no legacy hub→useState path anymore: entities still flow hub →
    // onMetadataApplied → (in-memory) replica → live queries.
    const realSetItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage as Storage, 'setItem').mockImplementation(
      (key: string, value: string) => {
        if (key.startsWith('podium.replica')) throw new Error('quota exceeded')
        realSetItem(key, value)
      },
    )

    render()
    await settle()
    expect(latest.sessions).toEqual([])

    act(() => sockets[0]?.onopen?.({}))
    await settle()
    expect(changesSinceCalls).toEqual([null])
    changesSinceResolve?.({
      kind: 'snapshot',
      sessions: [session('s-mem', 'memory path')],
      issues: [],
      conversations: [],
      diagnostics: [],
      cursor: 4,
    })
    await settle()
    expect(latest.sessions.map((s) => s.title)).toEqual(['memory path'])

    // Optimistic writes flow through the same replica seam (in memory).
    await act(async () => {
      await latestStore?.renameSession('s-mem', 'renamed')
    })
    await settle()
    expect(latest.sessions[0]?.name).toBe('renamed')

    // …and none of it leaked into durable storage.
    expect(
      Object.keys(localStorage).filter((k) => k.startsWith('podium.replica')),
    ).toEqual([])
  })
})
