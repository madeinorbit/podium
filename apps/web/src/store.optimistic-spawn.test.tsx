import type { IssueWire, SessionMeta, SyncChangesSinceResult } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { optimisticDraftIssue } from './optimistic-spawn'

// ---------------------------------------------------------------------------
// Optimistic new-session spawn (#119): clicking "New <Agent>" must paint a
// 'starting' session + its draft-issue vessel INSTANTLY (before any server
// round-trip), reconcile seamlessly when the server's broadcast lands with the
// same client-minted ids, and roll the optimistic rows back if the create fails.
// The real StoreProvider + replica run; only tRPC and the WebSocket are faked.
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

let changesSinceResolve: ((r: SyncChangesSinceResult) => void) | undefined
const createCalls: Array<Record<string, unknown>> = []
let createDeferred: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | undefined

const fakeTrpc = {
  sync: {
    changesSince: {
      query: () =>
        new Promise<SyncChangesSinceResult>((resolve) => {
          changesSinceResolve = resolve
        }),
    },
  },
  discovery: { refreshRepos: { mutate: async () => ({ repositories: [], diagnostics: [] }) } },
  pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
  tabs: { listOrders: { query: async () => ({}) } },
  settings: { get: { query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } }) } },
  sessions: {
    create: {
      mutate: (input: Record<string, unknown>) => {
        createCalls.push(input)
        return new Promise((resolve, reject) => {
          createDeferred = { resolve, reject }
        })
      },
    },
    resumeAndSend: { mutate: async () => ({}) },
    rename: { mutate: async () => ({}) },
  },
}

vi.mock('./trpc', () => ({ makeTrpc: () => fakeTrpc }))

const { StoreProvider, useStore } = await import('./store')

const sockets: FakeWS[] = []
class FakeWS {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(_url: string) {
    sockets.push(this)
  }
  send(): void {}
  close(): void {}
}

function serverSession(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    title: 'real',
    cwd: '/w/wt',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    ...over,
  }
}

let latest: { sessions: SessionMeta[]; issues: IssueWire[] } = { sessions: [], issues: [] }
let store: ReturnType<typeof useStore> | null = null
function Probe(): null {
  const s = useStore()
  latest = { sessions: s.sessions, issues: s.issues }
  store = s
  return null
}

let container: HTMLDivElement
let root: Root
let realWS: typeof WebSocket

beforeEach(() => {
  localStorage.clear()
  sockets.length = 0
  createCalls.length = 0
  createDeferred = undefined
  changesSinceResolve = undefined
  latest = { sessions: [], issues: [] }
  store = null
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

function spawn(): { sessionId: string; issueId: string } {
  let ids: { sessionId: string; issueId: string } = { sessionId: '', issueId: '' }
  act(() => {
    ids = store!.spawnDraftAgent({
      target: { path: '/w/wt', repoPath: '/w' },
      agentKind: 'claude-code',
    })
  })
  return ids
}

describe('optimistic new-session spawn', () => {
  it('paints a starting session + draft issue instantly, before the create resolves', async () => {
    render()
    await settle()
    expect(latest.sessions).toEqual([])

    const ids = spawn()
    await settle()

    // The row is visible even though the create mutation is still pending.
    const s = latest.sessions.find((x) => x.sessionId === ids.sessionId)
    expect(s?.status).toBe('starting')
    expect(s?.issueId).toBe(ids.issueId)
    expect(latest.issues.map((i) => i.id)).toContain(ids.issueId)

    // ...and the create was fired with the client-minted ids so the server reuses them.
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.sessionId).toBe(ids.sessionId)
    expect(createCalls[0]?.draftIssue).toEqual({ repoPath: '/w', issueId: ids.issueId })
  })

  it('reconciles without duplicating when the server broadcast (same ids) lands', async () => {
    render()
    await settle()
    const ids = spawn()
    await settle()
    await act(async () => createDeferred?.resolve({ sessionId: ids.sessionId }))

    // Server truth arrives carrying the same ids.
    act(() => sockets[0]?.onopen?.({}))
    await settle()
    changesSinceResolve?.({
      kind: 'snapshot',
      sessions: [serverSession(ids.sessionId, { status: 'starting', issueId: ids.issueId })],
      issues: [
        optimisticDraftIssue({
          issueId: ids.issueId,
          repoPath: '/w',
          agentKind: 'claude-code',
          nowIso: '2026-07-01T00:00:00.000Z',
        }),
      ],
      conversations: [],
      diagnostics: [],
      cursor: 1,
    })
    await settle()

    expect(latest.sessions.filter((s) => s.sessionId === ids.sessionId)).toHaveLength(1)
    expect(latest.issues.filter((i) => i.id === ids.issueId)).toHaveLength(1)
  })

  it('rolls the optimistic session + issue back if the create fails', async () => {
    render()
    await settle()
    const ids = spawn()
    await settle()
    expect(latest.sessions.some((s) => s.sessionId === ids.sessionId)).toBe(true)

    await act(async () => createDeferred?.reject(new Error('daemon offline')))
    await settle()

    expect(latest.sessions.some((s) => s.sessionId === ids.sessionId)).toBe(false)
    expect(latest.issues.some((i) => i.id === ids.issueId)).toBe(false)
  })
})
