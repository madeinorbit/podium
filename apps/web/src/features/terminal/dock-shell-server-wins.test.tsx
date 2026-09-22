// @vitest-environment happy-dom
import { asSessionId, type SessionId, type SessionMeta } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * POD-4527: the device-local `dockShells` map is a cache, not the authority.
 * POD-4436's migration comment ("remain valid as a cache until the server
 * answers, then the server wins") is the rule: the panel renders the cached
 * shell only until `shells.forWorktree` answers, then the server's id wins —
 * even when the cached shell is still live.
 */

const CACHE_ID = asSessionId('dock-cache')
const SERVER_ID = asSessionId('dock-server')

type ForWorktreeResult = { sessionId: SessionId; created: boolean }

let resolveServer!: (value: ForWorktreeResult) => void
const forWorktreeMutate = vi.fn(
  () =>
    new Promise<ForWorktreeResult>((resolve) => {
      resolveServer = resolve
    }),
)
const setDockShell = vi.fn((cwd: string, sessionId: SessionId | null) => {
  if (sessionId) dockShells[cwd] = sessionId
  else delete dockShells[cwd]
})
const setDockVisibleSession = vi.fn()

let storeSessions: SessionMeta[] = []
const dockShells: Record<string, SessionId> = {}

const mockState = {
  hub: { subscribeTranscript: () => () => {} },
  trpc: {
    sessions: {
      create: { mutate: vi.fn(async () => ({ sessionId: asSessionId('unused') })) },
      setArchived: { mutate: vi.fn(async () => undefined) },
    },
    shells: {
      forWorktree: { mutate: forWorktreeMutate },
    },
  },
  sessions: storeSessions,
  machines: [],
  reposLoaded: true,
  dockShells,
  setDockShell,
  setDockVisibleSession,
  resurrectSession: vi.fn(async () => ({ ok: true })),
  killSession: vi.fn(async () => {}),
  issues: [],
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) => sel(mockState),
  useReplicaIssues: () => [],
}))

vi.mock('@podium/terminal-client-react', () => ({
  useTerminalSession: () => ({
    containerRef: { current: null },
    viewportRef: { current: null },
    mountedRef: { current: null },
    ready: true,
  }),
}))

vi.mock('./use-terminal-appearance', () => ({
  useTerminalAppearance: () => ({
    settings: {},
    appearance: {},
  }),
}))

const { DockShellPanel } = await import('./DockShellPanel')

function shellMeta(over: Omit<Partial<SessionMeta>, 'sessionId'> & { sessionId: string }): SessionMeta {
  const { sessionId, ...rest } = over
  return {
    sessionId: asSessionId(sessionId),
    agentKind: 'shell',
    archived: false,
    status: 'live',
    cwd: '/repo/a',
    ...rest,
  } as unknown as SessionMeta
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  forWorktreeMutate.mockClear()
  setDockShell.mockClear()
  setDockVisibleSession.mockClear()
  for (const key of Object.keys(dockShells)) delete dockShells[key]
  // This device remembers a LIVE shell for the worktree; the server knows a
  // different live shell (e.g. created on another device first). Both rows
  // are present so the panel can render either one.
  dockShells['/repo/a'] = CACHE_ID
  storeSessions = [
    shellMeta({ sessionId: 'dock-cache', status: 'live' }),
    shellMeta({ sessionId: 'dock-server', status: 'live' }),
  ]
  mockState.sessions = storeSessions
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function visibleSequence(): (SessionId | null)[] {
  return setDockVisibleSession.mock.calls.map((call) => call[0] as SessionId | null)
}

describe('POD-4527 server wins over the device-local dock cache', () => {
  it('asks the server even for a live cached shell, then renders the server id', async () => {
    await act(async () => {
      root.render(<DockShellPanel cwd="/repo/a" />)
    })
    await flush()

    // A live cache must NOT suppress the question: the panel asks the server
    // on mount even though the cached shell is alive and rendered.
    expect(forWorktreeMutate).toHaveBeenCalledTimes(1)
    expect(forWorktreeMutate).toHaveBeenCalledWith({ worktreePath: '/repo/a' })

    // While the answer is in flight the CACHE renders — that brief cached
    // frame is intended (instant local paint), and pinned here.
    expect(visibleSequence()).toContain(CACHE_ID)

    // The server answers with the other device's shell.
    await act(async () => {
      resolveServer({ sessionId: SERVER_ID, created: false })
    })
    await flush()
    // The mock store has no subscriptions, so re-render to pick up the write.
    await act(async () => {
      root.render(<DockShellPanel cwd="/repo/a" />)
    })
    await flush()

    // The server wins: the cache is rewritten and the panel ends on its id —
    // and the cached frame came FIRST (no repaired flicker hiding here).
    expect(setDockShell).toHaveBeenCalledWith('/repo/a', SERVER_ID)
    expect(dockShells['/repo/a']).toBe(SERVER_ID)
    const sequence = visibleSequence()
    expect(sequence).toContain(SERVER_ID)
    expect(sequence.indexOf(CACHE_ID)).toBeLessThan(sequence.indexOf(SERVER_ID))
  })

  it('leaves the mapping alone when the server agrees with the cache', async () => {
    await act(async () => {
      root.render(<DockShellPanel cwd="/repo/a" />)
    })
    await flush()

    expect(forWorktreeMutate).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveServer({ sessionId: CACHE_ID, created: false })
    })
    await flush()
    await act(async () => {
      root.render(<DockShellPanel cwd="/repo/a" />)
    })
    await flush()

    // Agreement means no remap churn: reconcile once, write nothing.
    expect(forWorktreeMutate).toHaveBeenCalledTimes(1)
    expect(setDockShell).not.toHaveBeenCalled()
    expect(dockShells['/repo/a']).toBe(CACHE_ID)
    expect(visibleSequence()).toContain(CACHE_ID)
    expect(visibleSequence()).not.toContain(SERVER_ID)
  })
})
