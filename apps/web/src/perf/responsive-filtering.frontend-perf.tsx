import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'
import { initializeSidebarDataLayer } from '@/lib/sidebar-data-layer'
import { createSidebarFixture } from '../../test/sidebar-fixture'

const ISSUE_COUNT = 674
const NOW = Date.parse('2026-08-23T12:00:00.000Z')

function issueAt(index: number) {
  return {
    id: `issue-${index}`,
    repoPath: '/repo',
    seq: 10_000 + index,
    displayRef: `POD-${10_000 + index}`,
    title: index === ISSUE_COUNT - 1 ? 'Only responsive target' : `Generated task ${index}`,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    blockedByNotes: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: 2,
    type: 'task',
    pinned: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    readAt: '2026-08-20T00:00:00.000Z',
    unread: false,
  }
}

function sessionAt(index: number) {
  return {
    sessionId: `session-${index}`,
    agentKind: 'codex',
    cwd: '/repo',
    title: `Generated session ${index}`,
    status: 'live',
    controllerId: null,
    geometry: { cols: 120, rows: 36 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-20T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    issueId: `issue-${index}`,
    busy: false,
    readAt: '2026-08-20T00:00:00.000Z',
    unread: false,
    agentState: { phase: 'idle', idle: { kind: 'done' } },
  }
}

const largeState = vi.hoisted(() => ({ store: {} as Record<string, unknown>, pool: false }))

vi.mock('@/app/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/app/store')>()
  const useStore = () => largeState.store
  const useLegacyIssues = () => largeState.store.issues ?? []
  const useLegacySelector: typeof original.useStoreSelector = (selector) =>
    selector(largeState.store as unknown as Parameters<typeof selector>[0])
  return {
    useStore: () => {
      const useRead = largeState.pool ? original.useStore : useStore
      return useRead()
    },
    useReplicaIssues: () => {
      const useRead = largeState.pool ? original.useReplicaIssues : useLegacyIssues
      return useRead()
    },
    useStoreSelector: (
      selector: (store: Record<string, unknown>) => unknown,
      equal?: (a: unknown, b: unknown) => boolean,
    ) => {
      const useRead = largeState.pool ? original.useStoreSelector : useLegacySelector
      return useRead(selector as unknown as Parameters<typeof original.useStoreSelector>[0], equal)
    },
    useSlice: (definition: { derive: (store: Record<string, unknown>) => unknown }) => {
      if (largeState.pool) throw new Error('Responsive pool sidebar read a legacy slice')
      return definition.derive(largeState.store)
    },
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTMLInputElement.value setter is unavailable')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  cleanup()
  largeState.pool = false
})

describe('large-state responsive filtering', () => {
  it('commits the urgent work query before the deferred 674-row tree, then settles', async () => {
    const issues = Array.from({ length: ISSUE_COUNT }, (_, index) => issueAt(index))
    largeState.store = {
      coarseNow: NOW,
      repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
      sessions: Array.from({ length: ISSUE_COUNT }, (_, index) => sessionAt(index)),
      machines: [],
      pins: { panels: [], worktrees: [], repos: [] },
      issues,
      selectedWorktree: null,
      selectedIssueId: null,
      paneA: null,
      fileTabs: [],
      view: 'workspace',
      sidebarSettings: { groupByRepo: false },
      uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
      trpc: {
        settings: { get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'codex' } })) } },
        issues: { defer: { mutate: vi.fn(async () => ({})) } },
      },
      setPinned: vi.fn(),
      setSelectedWorktree: vi.fn(),
      setSelectedIssueId: vi.fn(),
      setOpenIssueId: vi.fn(),
      setPane: vi.fn(),
      setView: vi.fn(),
      setSidebarSettings: vi.fn(),
      spawnDraftAgent: vi.fn(),
      markIssueRead: vi.fn(),
      markSessionRead: vi.fn(),
    }

    render(<SidebarUnified />)
    const input = screen.getByTestId('work-search-input') as HTMLInputElement
    expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(ISSUE_COUNT)

    flushSync(() => setNativeInputValue(input, 'only responsive target'))

    // The controlled field has committed, while the deferred list still shows
    // its previous complete tree. No timer or elapsed-time threshold is involved.
    expect(input.value).toBe('only responsive target')
    expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(ISSUE_COUNT)
    expect(screen.getByTestId('work-search-count').textContent).toBe('674/674')

    await act(async () => {})

    const settled = screen.getAllByTestId('unified-issue-row')
    expect(settled).toHaveLength(1)
    expect(settled[0]?.textContent).toContain('Only responsive target')
    expect(screen.getByTestId('work-search-count').textContent).toBe('1/674')
  }, 20_000)

  it('commits the urgent query before the deferred 674-row pool sidebar, then settles', async () => {
    largeState.pool = true
    history.replaceState(null, '', '/?mobxSidebar=1')
    initializeSidebarDataLayer({ get: () => null })
    const fixture = createSidebarFixture(ISSUE_COUNT, Date.now(), true)
    render(
      <StoreProvider
        principal={asClientPrincipal(asUserId('responsive-pool'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={fixture.api}
        createReplicaFn={() => fixture.replica}
        networkEnabled={false}
        onFatalError={(message) => {
          throw new Error(message)
        }}
        attachRuntime={(runtime) =>
          attachWorklistPool(runtime, (error) => {
            throw error
          })
        }
      >
        <SidebarUnified />
      </StoreProvider>,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const input = (await screen.findByTestId(
      'work-search-input',
      {},
      { timeout: 10000 },
    )) as HTMLInputElement
    await waitFor(
      () => expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(ISSUE_COUNT),
      { timeout: 10000 },
    )
    expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(ISSUE_COUNT)
    flushSync(() => setNativeInputValue(input, 'only responsive target'))
    expect(input.value).toBe('only responsive target')
    expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(ISSUE_COUNT)
    expect(screen.getByTestId('work-search-count').textContent).toBe('674/674')
    await act(async () => {})
    expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(1)
    expect(screen.getByTestId('work-search-count').textContent).toBe('1/674')
    largeState.pool = false
  }, 20_000)
})
