import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// react-dom/client's createRoot+act path checks this global.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Task 8: the web store reports per-session view-state to the backend whenever
// the rendered panes or input focus change. We mount the REAL StoreProvider with
// a fake SocketHub (captures setViewState calls) + a fake trpc (so boot resolves
// without network), then drive setPane/setFocusedPane/toggleSplit through a test
// consumer and assert the derived (visible, focused) tuple.
//
// `visible`  = tab-visible ? [paneA, split ? paneB : null].filter(Boolean) : []
// `focused`  = tab-visible ? (effectivePane === 'A' ? paneA : paneB) : null
// where effectivePane clamps to 'A' when split is off.
// ---------------------------------------------------------------------------

interface ViewStateCall {
  visible: string[]
  focused: string | null
}

let lastHub: FakeHub
class FakeHub {
  viewStates: ViewStateCall[] = []
  visibleCalls: boolean[] = []
  constructor() {
    lastHub = this
  }
  setViewState(visible: string[], focused: string | null): void {
    this.viewStates.push({ visible, focused })
  }
  setVisible(v: boolean): void {
    this.visibleCalls.push(v)
  }
  // Boot wiring touched by StoreProvider's mount effect — inert stubs.
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
  connect() {}
  dispose() {}
  sendSessionDraft() {}
}

vi.mock('@podium/terminal-client', () => ({
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
  setPane: (p: 'A' | 'B', id: string | null) => void
  setFocusedPane: (p: 'A' | 'B') => void
  toggleSplit: () => void
} | null = null

function Consumer(): null {
  const s = useStore()
  api = { setPane: s.setPane, setFocusedPane: s.setFocusedPane, toggleSplit: s.toggleSplit }
  return null
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
      <StoreProvider config={{ wsClientUrl: 'ws://x', httpOrigin: 'http://x' }} onFatalError={() => {}}>
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
    act(() => api?.setPane('A', 's1'))
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })
  })

  it('split off: paneB is NOT visible and focus stays on A even if B is set', () => {
    mount()
    act(() => {
      api?.setPane('A', 's1')
      api?.setPane('B', 's2')
    })
    // split is false → only A is visible/focused.
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })
  })

  it('split on: both panes visible; focus follows focusedPane', () => {
    mount()
    act(() => {
      api?.setPane('A', 's1')
      api?.setPane('B', 's2')
      api?.toggleSplit() // split → true
      api?.setFocusedPane('A') // selecting B above focused it; pull focus back to A
    })
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's1' })
    act(() => api?.setFocusedPane('B'))
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's2' })
  })

  it('selecting a pane focuses it (setPane drives focusedPane)', () => {
    mount()
    act(() => {
      api?.setPane('A', 's1')
      api?.setPane('B', 's2')
      api?.toggleSplit() // split on so paneB is visible + focusable
    })
    // The last selected pane was B → it holds focus.
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's2' })
    act(() => api?.setPane('A', 's3'))
    expect(last()).toEqual({ visible: ['s3', 's2'], focused: 's3' })
  })

  it('clamps focus to A when split turns off while focusedPane was B', () => {
    mount()
    act(() => {
      api?.setPane('A', 's1')
      api?.setPane('B', 's2')
      api?.toggleSplit() // split on
      api?.setFocusedPane('B') // focus B
    })
    expect(last()).toEqual({ visible: ['s1', 's2'], focused: 's2' })
    act(() => api?.toggleSplit()) // split off
    // focusedPane is still 'B' internally but must be treated as 'A'.
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })
  })

  it('drops nulls from visible (empty pane is not reported)', () => {
    mount()
    act(() => {
      api?.setPane('A', 's1')
      api?.toggleSplit() // split on, paneB still null
    })
    expect(last()).toEqual({ visible: ['s1'], focused: 's1' })
  })

  it('hiding the tab clears view-state via the visibilitychange listener', () => {
    mount()
    act(() => api?.setPane('A', 's1'))
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
