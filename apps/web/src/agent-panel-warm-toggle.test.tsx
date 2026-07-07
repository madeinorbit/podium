// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Warm chat<->native toggle (Task 6): the terminal must stay MOUNTED across a
// native->chat->native cycle. mountSession is called exactly once, dispose is
// never called, and only setActive(false) then setActive(true) flip the hidden
// terminal's size eligibility (Task 3 wiring).
// ---------------------------------------------------------------------------

const setActive = vi.fn()
const dispose = vi.fn()
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

vi.mock('@/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

vi.mock('./voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))

let storeSessions: SessionMeta[] = []
let storePanelMode: Record<string, 'chat' | 'native'> = {}

const fakeHub = {
  subscribeTranscript: (_s: string, _since: string | undefined, _cb: unknown): (() => void) => {
    return () => {}
  },
}

const fakeTrpc = {
  settings: {
    get: { query: vi.fn(async () => ({ sessionDefaults: { startScreen: 'native' as const } })) },
  },
}

// Stable fn identities across renders (real Zustand selectors are memoized) so
// the mount effect's deps — which include setSessionDraft/openFile — don't churn
// and spuriously re-run the effect on every render.
const stableStoreFns = {
  startBtw: vi.fn(async () => {}),
  setSessionDraft: vi.fn(),
  hibernateSession: vi.fn(async () => {}),
  openFile: vi.fn(),
  setPanelMode: vi.fn(),
  setPanelRenderMode: vi.fn(),
  resurrectSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
}

vi.mock('./store', () => ({
  useStore: () => ({
    hub: fakeHub,
    sessions: storeSessions,
    machines: [],
    repos: [],
    trpc: fakeTrpc,
    drafts: {},
    panelMode: storePanelMode,
    ...stableStoreFns,
  }),
}))

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

describe('AgentPanel warm chat<->native toggle', () => {
  it('reuses the same terminal instance across a native->chat->native toggle', async () => {
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    expect(mountSessionMock).toHaveBeenCalledTimes(1)

    // native -> chat: the terminal stays mounted (hidden), just inactive.
    setActive.mockClear()
    storePanelMode = { s1: 'chat' }
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    expect(setActive).toHaveBeenCalledWith(false)

    // chat -> native: same instance, re-activated.
    setActive.mockClear()
    storePanelMode = { s1: 'native' }
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    expect(setActive).toHaveBeenCalledWith(true)

    // The whole cycle reused ONE terminal: no second mount, no dispose.
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
  })

  it('renders the terminal container in chat mode (hidden) so it stays mounted', async () => {
    storePanelMode = { s1: 'chat' }
    await act(async () => {
      root.render(<AgentPanel sessionId="s1" active />)
    })
    await flush()
    // The terminal is mounted even in chat mode.
    expect(mountSessionMock).toHaveBeenCalledTimes(1)
  })
})
