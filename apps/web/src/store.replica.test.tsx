import type { SessionMeta, SyncChangesSinceResult } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReplica } from './replica'

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
  }
}

let latest: { sessions: SessionMeta[] } = { sessions: [] }
function Probe(): null {
  const store = useStore()
  latest = { sessions: store.sessions }
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
  latest = { sessions: [] }
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
})
