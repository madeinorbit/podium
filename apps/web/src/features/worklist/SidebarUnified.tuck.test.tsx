// @vitest-environment happy-dom
//
// Tuck-away is SERVER state (POD-333). It used to live in this browser's local
// ui-state under `podium:sidebar:tucked:<id>`, so the fold reset on a different
// browser or machine and two open clients disagreed about what was tucked.
// These guard the two halves of the fix at the UI seam:
//
//  1. HYDRATION — the fold is painted from `issue.tuckedAt` on the very first
//     render, with no local storage consulted (the mocked ui-state here throws
//     if anything reads or writes it).
//  2. MUTATION — pressing Tuck away calls the store's `setIssueTucked`, whose
//     outbox entry both reaches the server and paints the optimistic fold.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

const setIssueTucked = vi.hoisted(() => vi.fn(async () => {}))
const uiState = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    get: vi.fn((key: string): string | null => rows.get(key) ?? null),
    set: vi.fn((key: string, value: string | null): void => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
      for (const listener of listeners) listener()
    }),
    subscribe: (callback: () => void): (() => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    reset: (): void => {
      rows.clear()
      listeners.clear()
    },
  }
})
/** Flipped per-test before render: the server's view of the row's ending. */
const state = vi.hoisted(() => ({
  tuckedAt: null as string | null,
  closedReason: 'done' as string,
  branch: null as string | null,
  gitState: null as Record<string, unknown> | null,
}))
/** Keys the tuck flag USED to live under — nothing may touch them any more. */
const tuckKeys = (calls: unknown[][]) => calls.filter(([k]) => String(k).includes('tucked'))

vi.mock('@/app/store', () => {
  const base = {
    repoPath: '/repo',
    prefix: 'POD',
    description: '',
    stage: 'done',
    closedReason: 'done',
    // Freshly finished (relative to the real clock the sidebar reads): inside the
    // grace window, so placement is decided by the tuck stamp alone rather than
    // by the grace backstop that eventually folds any finished row.
    closedAt: new Date(Date.now() - 60_000).toISOString(),
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedByNotes: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
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
    ready: false,
    blocked: false,
    deferred: false,
    unread: false,
    readAt: new Date(Date.now() - 30_000).toISOString(),
  }
  const useStore = () => ({
    // Reading or writing a local tuck flag is the bug. The fold's own disclosure
    // preference still uses the real subscribed UI-state contract.
    uiState,
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      {
        ...base,
        id: 'finished',
        seq: 42,
        displayRef: 'POD-42',
        title: 'Settled issue',
        tuckedAt: state.tuckedAt,
        closedReason: state.closedReason,
        branch: state.branch,
        gitState: state.gitState,
      },
    ],
    trpc: {
      settings: { get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'codex' } })) } },
      issues: {
        archive: { mutate: vi.fn(async () => ({})) },
        defer: { mutate: vi.fn(async () => ({})) },
        update: { mutate: vi.fn(async () => ({})) },
      },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: null,
    setSelectedIssueId: vi.fn(),
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    markIssueRead: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}),
    setIssueTucked,
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
  })
  return {
    useStore,
    useReplicaIssues: () => useStore().issues,
    useStoreSelector: (selector: (state: unknown) => unknown) => selector(useStore() as never),
    // POD-331: the worklist is a PUBLISHED slice now, so the component reads it
    // through `useSlice` instead of deriving it locally. These suites assert
    // BEHAVIOUR, not derivation counts, so this derives on every read rather
    // than memoizing — sharing is measured in src/perf/slice-render-count.test.tsx,
    // and a mock that pretended to memoize here would be a second, untested
    // implementation of the mechanism.
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  setIssueTucked.mockClear()
  uiState.get.mockClear()
  uiState.set.mockClear()
  uiState.reset()
  state.tuckedAt = null
  state.closedReason = 'done'
  state.branch = null
  state.gitState = null
})

describe('tuck-away persistence (POD-333)', () => {
  it('offers Tuck away on an untucked finish and dismisses through the store action', () => {
    render(<SidebarUnified />)
    // Untucked server truth: the finished row is still live and carries the control.
    expect(screen.queryByTestId('closed-issue-fold')).toBeNull()
    const control = screen.getByTestId('tuck-away')

    fireEvent.click(control)

    // The dismissal goes to the SERVER (outboxed store action), not to a
    // `podium:sidebar:tucked:*` key only this browser can see.
    expect(setIssueTucked).toHaveBeenCalledWith('finished', true)
    expect(tuckKeys(uiState.set.mock.calls)).toEqual([])
  })

  it.each([
    'cancelled',
    'duplicate',
  ] as const)('folds a %s ending without offering Tuck away', (closedReason) => {
    // The terminal outcome is already the operator's dismissal. Even an
    // abandoned private branch must not turn it into a second decision.
    state.closedReason = closedReason
    state.branch = 'issue/42-abandoned'
    state.gitState = {
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      branch: 'issue/42-abandoned',
      shared: false,
      merged: false,
      ahead: 3,
      dirtyFiles: 0,
    }

    render(<SidebarUnified />)

    expect(screen.getByTestId('closed-issue-fold')).toBeTruthy()
    expect(screen.queryByTestId('tuck-away')).toBeNull()
    expect(setIssueTucked).not.toHaveBeenCalled()
  })

  it('hydrates the fold from the wire, so a fresh browser sees the same tuck', () => {
    // Exactly what a different browser (or a reconnecting client) receives: the
    // issue arrives already stamped. No local state was ever written here.
    state.tuckedAt = new Date(Date.now() - 30_000).toISOString()

    render(<SidebarUnified />)

    // Folded on first paint, and the control is gone — it is already dismissed.
    // (The fold's own open/collapsed preference is still a local ui-state key;
    // what must NOT come from local storage is WHICH rows are in the fold.)
    expect(screen.getByTestId('closed-issue-fold')).toBeTruthy()
    expect(screen.queryByTestId('tuck-away')).toBeNull()
    expect(tuckKeys(uiState.get.mock.calls)).toEqual([])
  })

  it('shows when the issue was tucked rather than when it closed', async () => {
    // The row closed a minute ago (the fixture above) but entered Closed only
    // now. Its compact timestamp describes that later, operator-facing event.
    state.tuckedAt = new Date(Date.now() - 10_000).toISOString()

    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))

    const row = (await screen.findByText('Settled issue')).closest('[data-testid="folded-work-row"]')
    expect(row?.textContent).toContain('just now')
    expect(row?.textContent).not.toContain('1m ago')
  })
})
