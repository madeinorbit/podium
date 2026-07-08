// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Capture the latest MountedSession handed back by mountSession so we can assert
// against its setActive spy. The panel mounts the terminal only in native mode,
// so each native (re)mount produces a fresh mounted object; setActive is shared
// so cross-render calls accumulate on one spy.
// ---------------------------------------------------------------------------

const setActive = vi.fn()
const dispose = vi.fn()
// Loosely typed args (el, opts) so the captured opts.active is inspectable.
const mountSessionMock = vi.fn((_el: unknown, _opts: { active?: boolean }) => ({
  connection: {
    state: () => ({ role: 'controller' }),
    sendInput: vi.fn(),
    requestControl: vi.fn(),
  },
  view: {
    setFileLinks: vi.fn(),
    onScroll: () => () => {},
    atBottom: () => true,
    focus: vi.fn(),
    screenText: () => '',
    scrollToBottom: vi.fn(),
    requestPaste: vi.fn(),
  },
  setActive,
  dispose,
}))

vi.mock('@podium/terminal-client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    mountSession: (el: unknown, opts: { active?: boolean }) => mountSessionMock(el, opts),
  }
})

// The kill/archive guard reaches for a ConfirmProvider context that this focused
// render doesn't mount — stub the hook (it's only invoked on a click anyway).
vi.mock('@/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

// Voice touches browser speech APIs that are flaky under happy-dom — stub it.
vi.mock('./voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))

// The store: AgentPanel destructures these. panelMode drives effectiveMode
// (native vs chat) so a test can flip the mounted panel's mode without a prop.
let storeSessions: SessionMeta[] = []
let storePanelMode: Record<string, 'chat' | 'native'> = {}

const fakeHub = {
  subscribeTranscript: (_s: string, _since: string | undefined, _cb: unknown): (() => void) => {
    return () => {}
  },
}

const fakeTrpc = {
  settings: {
    // Resolve immediately so startScreen settles to a known value (native) and
    // doesn't asynchronously flip effectiveMode mid-test.
    get: { query: vi.fn(async () => ({ sessionDefaults: { startScreen: 'native' as const } })) },
  },
}

// Stable fn identities across renders (real Zustand selectors are memoized) so
// the mount effect's deps (which include setSessionDraft/openFile) don't churn
// and spuriously dispose+remount the terminal on every re-render.
const stableStoreFns = {
  startBtw: vi.fn(async () => {}),
  setSessionDraft: vi.fn(),
  hibernateSession: vi.fn(async () => {}),
  openFile: vi.fn(),
  setPanelMode: vi.fn(),
  setPanelRenderMode: vi.fn(),
  // Used by child components (SnoozeControl/Exited/Hibernated) on click only.
  resurrectSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
}

vi.mock('./store', () => {
  const useStore = () => ({
    hub: fakeHub,
    sessions: storeSessions,
    machines: [],
    pendingSpawnIds: new Set<string>(),
    repos: [],
    trpc: fakeTrpc,
    drafts: {},
    panelMode: storePanelMode,
    ...stableStoreFns,
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

const { AgentPanel } = await import('./AgentPanel')

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
    transcriptAvailable: true,
    resumable: true,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  storeSessions = [meta({})]
  storePanelMode = { s1: 'native' }
  setActive.mockClear()
  dispose.mockClear()
  mountSessionMock.mockClear()
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

describe('AgentPanel active wiring', () => {
  it('passes initial active to mountSession for a live native panel', async () => {
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    expect(mountSessionMock).toHaveBeenCalled()
    const opts = mountSessionMock.mock.calls[0]?.[1] as { active?: boolean } | undefined
    expect(opts?.active).toBe(true)
  })

  it('passes active:false to mountSession when the panel mounts inactive', async () => {
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active={false} />)
    })
    await flush()
    const opts = mountSessionMock.mock.calls[0]?.[1] as { active?: boolean } | undefined
    expect(opts?.active).toBe(false)
  })

  it('calls setActive(false) when the panel is backgrounded (active -> false)', async () => {
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    setActive.mockClear()
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active={false} />)
    })
    await flush()
    expect(setActive).toHaveBeenCalledWith(false)
    // …and never (re)asserted true while inactive.
    expect(setActive).not.toHaveBeenCalledWith(true)
  })

  it('calls setActive(true) again when an inactive panel becomes active', async () => {
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active={false} />)
    })
    await flush()
    setActive.mockClear()
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    expect(setActive).toHaveBeenCalledWith(true)
  })

  it('the initial active reflects chat mode: a panel that starts in chat mounts an INACTIVE terminal', async () => {
    storePanelMode = { s1: 'chat' }
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    // Task 6 keeps the terminal mounted (hidden under the chat overlay) in BOTH
    // modes, so it can warm-toggle without a re-attach. A chat-mode mount must
    // therefore be INACTIVE (active:false) so the hidden terminal never drives
    // the PTY size.
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    const opts = mountSessionMock.mock.calls[0]?.[1] as { active?: boolean } | undefined
    expect(opts?.active).toBe(false)
  })

  it('warm-toggle: a native->chat switch keeps the terminal and only flips it inactive (no dispose)', async () => {
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    dispose.mockClear()
    setActive.mockClear()
    // Flip the persisted mode to chat; effectiveMode becomes 'chat'. Task 6: the
    // terminal stays mounted (hidden) — it is NOT disposed; instead Task 3's
    // eligibility wiring calls setActive(false) so the hidden terminal stops
    // driving the PTY size.
    storePanelMode = { s1: 'chat' }
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    expect(dispose).not.toHaveBeenCalled()
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    expect(setActive).toHaveBeenCalledWith(false)
  })
})
