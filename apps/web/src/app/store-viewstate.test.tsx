import { asUserId } from '@podium/model'
import { asClientPrincipal } from '@podium/client-core/principal'
import { asSessionId, type SessionId } from '@podium/model'
import { createReplica } from '@podium/client-core/replica'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** These suites predate multi-user; they exercise ONE signed-in operator, which
 *  is what the shipped single-admin install is. */
const TEST_PRINCIPAL = asClientPrincipal(asUserId('operator'))

// react-dom/client's createRoot+act path checks this global.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Task 8: the web store reports per-session view-state to the backend whenever
// the rendered panes or input focus change. We mount the REAL StoreProvider with
// a fake SocketHub (captures setViewState calls) + a fake trpc (so boot resolves
// without network), then drive setPane/setFocusedPane/toggleSplit through a test
// consumer and assert the derived (visible, focused) tuple.
//
// `visible`  = tab-visible ? the active tab of every pane ON SCREEN : []
// `focused`  = tab-visible ? the active tab of the focused on-screen pane : null
// "On screen" is every leaf of the current workspace's layout when the view has
// said splitting is on, and the FIRST leaf only when it has not.
// ---------------------------------------------------------------------------

interface ViewStateCall {
  visible: string[]
  focused: string | null
}

let lastHub: FakeHub
class FakeHub {
  viewStates: ViewStateCall[] = []
  viewModeStates: Array<Record<string, 'native' | 'chat'> | undefined> = []
  visibleCalls: boolean[] = []
  constructor() {
    lastHub = this
  }
  setViewState(
    visible: string[],
    focused: string | null,
    modes?: Record<string, 'native' | 'chat'>,
  ): void {
    this.viewStates.push({ visible, focused })
    this.viewModeStates.push(modes)
  }
  setVisible(v: boolean): void {
    this.visibleCalls.push(v)
  }
  // Boot wiring touched by the engine's start() — inert stubs.
  /** The P5a `on()` subscription seam the engine wires events through. */
  on() {
    return () => {}
  }
  onSessions() {
    return () => {}
  }
  onIssues() {
    return () => {}
  }
  onIssueUpdated() {
    return () => {}
  }
  onHostMetrics() {
    return () => {}
  }
  onMachines() {
    return () => {}
  }
  onSessionDraft() {
    return () => {}
  }
  onAttention() {
    return () => {}
  }
  connectionHealth() {
    return { status: 'ok', rttMs: null, since: 0 }
  }
  onConnectionHealth() {
    return () => {}
  }
  connect() {}
  dispose() {}
  sendSessionDraft() {}
}

vi.mock('@podium/client-core/socket-transport', () => ({
  SocketHub: FakeHub,
}))

const fakeTrpc = {
  discovery: {
    refreshRepos: { mutate: vi.fn(async () => ({ repositories: [], diagnostics: [] })) },
  },
  pins: { list: { query: vi.fn(async () => ({ panels: [], repos: [], worktrees: [] })) } },
  tabs: { listOrders: { query: vi.fn(async () => ({})) } },
  settings: {
    get: { query: vi.fn(async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } })) },
  },
}
vi.mock('./trpc', () => ({
  makeTrpc: () => fakeTrpc,
}))
vi.mock('./AppErrorPage', () => ({ formatAppError: (_e: unknown, m: string) => m }))

const { StoreProvider, useStore } = await import('./store')

// A tiny consumer that publishes the store handlers onto a module-level ref so a
// test can imperatively drive pane/focus state.
let api: {
  setPane: (p: 'A' | 'B', id: SessionId | null) => void
  setFocusedPane: (p: 'A' | 'B') => void
  setSplitEnabled: (enabled: boolean) => void
  toggleSplit: () => void
  splitWorkspacePane: (paneId: string, axis: 'row' | 'column') => void
  focusWorkspacePane: (paneId: string) => void
  setPanelMode: (sessionId: SessionId, mode: 'native' | 'chat') => void
} | null = null

function Consumer(): null {
  const s = useStore()
  api = {
    setPane: s.setPane,
    setFocusedPane: s.setFocusedPane,
    setSplitEnabled: s.setSplitEnabled,
    toggleSplit: s.toggleSplit,
    splitWorkspacePane: s.splitWorkspacePane,
    focusWorkspacePane: s.focusWorkspacePane,
    setPanelMode: s.setPanelMode,
  }
  return null
}

/** Mount and stand in for the Workspace view, which is what tells the engine
 *  that a second pane is on screen (`tab-splitting` is its flag, not the
 *  engine's — see EngineState.splitEnabled). Every case below that drives a
 *  real split does this first; the one that does NOT is the flag-off case. */
function mountWithSplitting(): void {
  mount()
  act(() => api?.setSplitEnabled(true))
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // A clean slate every test: panes/split are restored from localStorage.
  try {
    localStorage.clear()
  } catch {
    // ignore — happy-dom provides it, but be defensive
  }
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  api = null
  vi.clearAllMocks()
})

function mount(): void {
  act(() => {
    root.render(
      <StoreProvider
        principal={TEST_PRINCIPAL}
        createReplicaFn={() => createReplica()}
        config={{ wsClientUrl: 'ws://x', httpOrigin: 'http://x' }}
        onFatalError={() => {}}
      >
        <Consumer />
      </StoreProvider>,
    )
  })
}

function last(): ViewStateCall {
  const calls = lastHub.viewStates
  return calls[calls.length - 1] as ViewStateCall
}

describe('store reports viewState', () => {
  it('reports the focused pane as paneA by default when only A is shown', () => {
    mount()
    act(() => api?.setPane('A', asSessionId('s1')))
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })
  })

  it('re-reports a visible session whenever its rendered mode changes', () => {
    mount()
    act(() => api?.setPane('A', asSessionId('s1')))
    expect(lastHub.viewModeStates.at(-1)).toEqual({ s1: 'native' })

    const beforeChat = lastHub.viewStates.length
    act(() => api?.setPanelMode(asSessionId('s1'), 'chat'))
    expect(lastHub.viewStates).toHaveLength(beforeChat + 1)
    expect(lastHub.viewModeStates.at(-1)).toEqual({ s1: 'chat' })

    const beforeNative = lastHub.viewStates.length
    act(() => api?.setPanelMode(asSessionId('s1'), 'native'))
    expect(lastHub.viewStates).toHaveLength(beforeNative + 1)
    expect(lastHub.viewModeStates.at(-1)).toEqual({ s1: 'native' })
  })

  it('split off: setPane(B) has no pane to write to, so only A is reported', () => {
    mount()
    act(() => {
      api?.setPane('A', asSessionId('s1'))
      api?.setPane('B', asSessionId('s2'))
    })
    // Pane B IS the second leaf pane, and a single-leaf layout has none — the
    // call is inert rather than a raw `paneB` write nothing renders.
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })
  })

  // POD-710 wave 2: `split` is DERIVED from the layout's leaf count, so a second
  // pane exists because the layout has one — `toggleSplit` is an adapter over
  // splitting/closing panes, not a scalar flip. These cases drive the real thing
  // and assert the same reported tuple.
  it('split on: both panes visible; focus follows focusedPane', () => {
    mountWithSplitting()
    act(() => {
      api?.setPane('A', asSessionId('s1'))
      api?.splitWorkspacePane('p1', 'row') // the new pane p2 takes focus
      api?.setPane('B', asSessionId('s2'))
      api?.focusWorkspacePane('p1')
    })
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's1' })
    act(() => api?.focusWorkspacePane('p2'))
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's2' })
  })

  it('selecting a pane focuses it (setPane drives focusedPane)', () => {
    mountWithSplitting()
    act(() => {
      api?.setPane('A', asSessionId('s1'))
      api?.splitWorkspacePane('p1', 'row')
      api?.setPane('B', asSessionId('s2'))
    })
    // The last selected pane was B → it holds focus.
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's2' })
    act(() => api?.setPane('A', asSessionId('s3')))
    expect(last()).toEqual({ visible: ['s3', 's2'], focused: 's3' })
  })

  it('clamps focus to A when split turns off while focusedPane was B', () => {
    mountWithSplitting()
    act(() => {
      api?.setPane('A', asSessionId('s1'))
      api?.splitWorkspacePane('p1', 'row')
      api?.setPane('B', asSessionId('s2'))
    })
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's2' })
    // Unsplitting merges pane B's tabs back into pane A rather than closing
    // them, so s2 stays open — it is simply no longer a pane of its own.
    act(() => api?.toggleSplit())
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })
  })

  it('drops nulls from visible (an empty pane is not reported)', () => {
    mountWithSplitting()
    act(() => {
      api?.setPane('A', asSessionId('s1'))
      api?.toggleSplit() // splits the one-tab pane, so the new pane is empty
    })
    // The new pane takes focus and has nothing in it: one visible session, and
    // no focused one — the operator's pane genuinely holds no session.
    expect(last()).toEqual({ visible: ['s1'], focused: null })
  })

  // A split layout is PRESERVED when `tab-splitting` goes off — the view then
  // renders its first leaf only. The engine cannot read the flag, so until the
  // view says otherwise it must not report the hidden pane: doing so gave that
  // session PTY-relay priority and let the mark-read reaction clear the unread
  // badge on a session the operator could not see.
  it('reports only the first pane when the view has not said splitting is on', () => {
    mountWithSplitting()
    act(() => {
      api?.setPane('A', asSessionId('s1'))
      api?.splitWorkspacePane('p1', 'row')
      api?.setPane('B', asSessionId('s2'))
    })
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's2' })

    // The flag goes off: the layout keeps both panes, the screen does not.
    act(() => api?.setSplitEnabled(false))
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })

    // …and turning it back on restores the arrangement, focus included.
    act(() => api?.setSplitEnabled(true))
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's2' })
  })

  it('hiding the tab clears view-state via the visibilitychange listener', () => {
    mount()
    act(() => api?.setPane('A', asSessionId('s1')))
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })
    // Hide the tab and fire the event — the listener must re-report empty/null.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(last()).toEqual({ visible: [], focused: null })
  })
})
