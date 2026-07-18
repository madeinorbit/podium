import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// react-dom/client's createRoot+act path checks this global.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Selector-scoped store (Phase 4 client-core unification, #15): components
// subscribing via useStoreSelector must NOT re-render when an unrelated slice
// changes — the whole point of moving off the rebuilt-every-render context
// value. The REAL StoreProvider runs; only tRPC and WebSocket are faked.
// ---------------------------------------------------------------------------

const fakeTrpc = {
  sync: { changesSince: { query: () => new Promise(() => {}) } },
  discovery: { refreshRepos: { mutate: async () => ({ repositories: [], diagnostics: [] }) } },
  pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
  tabs: { listOrders: { query: async () => ({}) } },
  settings: { get: { query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } }) } },
  quota: { summary: { query: () => new Promise(() => {}) } }, // HostIndicators → QuotaIndicator
}
vi.mock('./trpc', () => ({ makeTrpc: () => fakeTrpc }))

const { StoreProvider, useStore, useStoreSelector } = await import('./store')
const { Workspace } = await import('./Workspace')
const { CommandPalette } = await import('./CommandPalette')
const { HostIndicators } = await import('@/features/machines/HostIndicators')
const { ConfirmProvider } = await import('@/lib/hooks/use-confirm')

class FakeWS {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(_data: string): void {}
  close(): void {}
}

let renders: Record<string, number> = {}
let latestStore: ReturnType<typeof useStore> | null = null

function ViewProbe(): null {
  renders.view = (renders.view ?? 0) + 1
  useStoreSelector((s) => s.view)
  return null
}
function DraftsProbe(): null {
  renders.drafts = (renders.drafts ?? 0) + 1
  useStoreSelector((s) => s.drafts)
  return null
}
function CompatProbe(): null {
  renders.compat = (renders.compat ?? 0) + 1
  latestStore = useStore()
  return null
}

let container: HTMLDivElement
let root: Root
let realWS: typeof WebSocket

beforeEach(() => {
  localStorage.clear()
  renders = {}
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

async function render(): Promise<void> {
  act(() => {
    root.render(
      <StoreProvider
        config={{ httpOrigin: 'http://x', wsClientUrl: 'ws://x' }}
        onFatalError={() => {}}
      >
        <ViewProbe />
        <DraftsProbe />
        <CompatProbe />
      </StoreProvider>,
    )
  })
  await settle()
}

describe('selector-scoped store', () => {
  it('a slice subscriber does not re-render when an unrelated slice changes', async () => {
    await render()
    const viewBefore = renders.view ?? 0
    const draftsBefore = renders.drafts ?? 0

    // Change ONLY the drafts slice.
    act(() => latestStore?.setSessionDraft('s1', 'hello'))
    await settle()

    expect(renders.drafts).toBe(draftsBefore + 1)
    expect(renders.view).toBe(viewBefore) // untouched slice → zero re-renders

    // Sanity: the drafts subscriber got the new value.
    expect(latestStore?.drafts).toEqual({ s1: 'hello' })
  })

  it('the selected slice still re-renders its subscriber on change', async () => {
    await render()
    const viewBefore = renders.view ?? 0
    act(() => latestStore?.setView('usage'))
    await settle()
    expect(renders.view).toBeGreaterThan(viewBefore)
    expect(latestStore?.view).toBe('usage')
  })

  it('converted hot components do not re-commit when an unrelated slice changes', async () => {
    // The REAL components (now on useStoreSelector slices), instrumented via
    // React Profiler: an unrelated store write (a session draft) must not
    // re-commit their subtrees. Before the conversion each useStore() consumer
    // re-rendered on every store publish.
    const { Profiler } = await import('react')
    const commits: Record<string, number> = {}
    const track =
      (id: string) =>
      (...[, phase]: [string, string]) => {
        if (phase !== 'mount') commits[id] = (commits[id] ?? 0) + 1
      }
    act(() => {
      root.render(
        <StoreProvider
          config={{ httpOrigin: 'http://x', wsClientUrl: 'ws://x' }}
          onFatalError={() => {}}
        >
          <CompatProbe />
          <ConfirmProvider>
            <Profiler id="workspace" onRender={track('workspace')}>
              <Workspace />
            </Profiler>
            <Profiler id="palette" onRender={track('palette')}>
              <CommandPalette />
            </Profiler>
            <Profiler id="host-indicators" onRender={track('host-indicators')}>
              <HostIndicators />
            </Profiler>
          </ConfirmProvider>
        </StoreProvider>,
      )
    })
    await settle()
    const before = { ...commits }

    // Unrelated slice: none of the three read `drafts`.
    act(() => latestStore?.setSessionDraft('s1', 'hello'))
    await settle()

    expect(commits.workspace ?? 0).toBe(before.workspace ?? 0)
    expect(commits.palette ?? 0).toBe(before.palette ?? 0)
    expect(commits['host-indicators'] ?? 0).toBe(before['host-indicators'] ?? 0)

    // Sanity: a slice they DO read (paneA via setPane) re-commits Workspace.
    act(() => latestStore?.setPane('A', 'session-1'))
    await settle()
    expect(commits.workspace ?? 0).toBeGreaterThan(before.workspace ?? 0)
  })

  it('compat useStore() keeps snapshot identity across a no-op provider render', async () => {
    await render()
    const snapA = latestStore
    // A drafts write that sets the SAME value is a no-op — the store publishes a
    // shallow-equal object and keeps the old snapshot identity.
    act(() => latestStore?.setSessionDraft('s1', 'x'))
    await settle()
    const snapB = latestStore
    expect(snapB).not.toBe(snapA)
    act(() => latestStore?.setSessionDraft('s1', 'x'))
    await settle()
    expect(latestStore).toBe(snapB)
  })
})
