import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// react-dom/client's createRoot+act path checks this global.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Regression: /workspace?wt=<nonexistent>&pane=<unknown-session> must settle
// deterministically — NOT ping-pong between the URL→state and state→URL sync
// effects (React error #185, maximum update depth exceeded). We mount the REAL
// StoreProvider on that deep link with a repo list that does NOT contain the
// wt path and no session matching the pane, and assert the render count stays
// bounded and the store lands on a sane fallback selection.
// ---------------------------------------------------------------------------

class FakeHub {
  setViewState(): void {}
  setVisible(): void {}
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
  seedMetadata() {}
  connect() {}
  dispose() {}
  sendSessionDraft() {}
}

vi.mock('@podium/terminal-client', () => ({
  SocketHub: FakeHub,
}))

const realRepo = {
  path: '/tmp/known-repo',
  kind: 'repository' as const,
  branch: 'main',
  worktrees: [],
}

const fakeTrpc = {
  discovery: {
    refreshRepos: { mutate: vi.fn(async () => ({ repositories: [realRepo], diagnostics: [] })) },
  },
  pins: { list: { query: vi.fn(async () => ({ panels: [], repos: [], worktrees: [] })) } },
  tabs: { listOrders: { query: vi.fn(async () => ({})) } },
  settings: {
    get: {
      query: vi.fn(async () => ({
        sidebar: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
      })),
    },
  },
}
vi.mock('./trpc', () => ({
  makeTrpc: () => fakeTrpc,
}))
vi.mock('./AppErrorPage', () => ({ formatAppError: (_e: unknown, m: string) => m }))

const { StoreProvider, useStore } = await import('./store')

let renderCount = 0
let snapshot: {
  selectedWorktree: string | null
  paneA: string | null
  view: string
} | null = null

function Consumer(): null {
  const s = useStore()
  renderCount++
  snapshot = { selectedWorktree: s.selectedWorktree, paneA: s.paneA, view: s.view }
  // The bug manifested as an unbounded update loop (React #185). Fail fast and
  // legibly instead of letting React blow the stack.
  if (renderCount > 200) throw new Error(`update loop: consumer rendered ${renderCount} times`)
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  renderCount = 0
  snapshot = null
  try {
    localStorage.clear()
  } catch {
    // defensive — happy-dom provides it
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
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

async function mountAt(url: string): Promise<void> {
  window.history.replaceState(null, '', url)
  await act(async () => {
    root.render(
      <StoreProvider
        config={{ wsClientUrl: 'ws://x', httpOrigin: 'http://x' }}
        onFatalError={(m) => {
          throw new Error(`fatal: ${m}`)
        }}
      >
        <Consumer />
      </StoreProvider>,
    )
  })
  // Let boot (repos fetch) + the route/selection sync effects fully settle.
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

describe('workspace deep link with unknown wt/pane', () => {
  it('settles without an update loop and falls back to a known worktree', async () => {
    await mountAt(
      '/workspace?wt=%2Fhome%2Fnobody%2Fgone&pane=00000000-0000-0000-0000-000000000000',
    )
    // Bounded render count — the URL↔state sync must converge, not ping-pong.
    expect(renderCount).toBeLessThan(60)
    expect(snapshot?.view).toBe('workspace')
    // The unknown worktree cannot be shown; the selection settles on the one
    // known worktree (a deterministic fallback, not a loop).
    expect(snapshot?.selectedWorktree).toBe('/tmp/known-repo')
    // And the settled state is mirrored back into the URL exactly once.
    expect(window.location.pathname).toBe('/workspace')
    expect(new URLSearchParams(window.location.search).get('wt')).toBe('/tmp/known-repo')
  })

  it('navigating (popstate) to an unknown wt settles without a loop (React #185 regression)', async () => {
    await mountAt('/workspace?wt=%2Ftmp%2Fknown-repo')
    expect(snapshot?.selectedWorktree).toBe('/tmp/known-repo')
    renderCount = 0
    // Simulate back/forward to a workspace URL whose wt doesn't exist. Before the
    // fix this ping-ponged the URL between the unknown path and the fallback
    // (URL→state adopt vs. worktree-fallback vs. state→URL mirror) — an
    // unbounded update loop that crashed with React error #185.
    await act(async () => {
      window.history.pushState(null, '', '/workspace?wt=%2Ftmp%2Fother&pane=s1')
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(renderCount).toBeLessThan(60)
    // The pane is adopted (Workspace holds/clears unknown panes safely) …
    expect(snapshot?.paneA).toBe('s1')
    // … while the unknown worktree settles on the known fallback, mirrored into
    // the URL exactly once.
    expect(snapshot?.selectedWorktree).toBe('/tmp/known-repo')
    expect(new URLSearchParams(window.location.search).get('wt')).toBe('/tmp/known-repo')
  })

  it('settles when there are no known worktrees at all', async () => {
    fakeTrpc.discovery.refreshRepos.mutate.mockImplementationOnce(async () => ({
      repositories: [],
      diagnostics: [],
    }))
    await mountAt('/workspace?wt=%2Fhome%2Fnobody%2Fgone&pane=dead-beef')
    expect(renderCount).toBeLessThan(60)
    expect(snapshot?.view).toBe('workspace')
  })
})
