// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

const archiveMutate = vi.hoisted(() => vi.fn(async () => ({})))

vi.mock('@/app/store', () => {
  const closed = {
    id: 'closed',
    repoPath: '/repo',
    prefix: 'POD',
    displayRef: 'POD-42',
    seq: 42,
    title: 'Settled issue',
    description: '',
    stage: 'done',
    closedReason: 'done',
    closedAt: '2026-07-23T10:00:00.000Z',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    blockedBy: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z',
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
    readAt: '2026-07-23T11:00:00.000Z',
  }

  const snoozed = {
    ...closed,
    id: 'snoozed',
    seq: 43,
    displayRef: 'POD-43',
    title: 'Snoozed issue',
    stage: 'in_progress',
    closedReason: null,
    closedAt: undefined,
    deferUntil: '2099-01-01T00:00:00.000Z',
    deferred: true,
  }
  const returned = {
    ...snoozed,
    id: 'returned',
    seq: 44,
    displayRef: 'POD-44',
    title: 'Returned issue',
    deferUntil: '2020-01-01T00:00:00.000Z',
    deferred: false,
  }
  const useStore = () => ({
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [closed, snoozed, returned],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'codex' } })) },
      },
      issues: {
        archive: { mutate: archiveMutate },
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
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  archiveMutate.mockClear()
})
describe('closed issue fold lifecycle', () => {
  it('folds snoozed rows with arrival motion and removes every drag target', () => {
    render(<SidebarUnified />)

    const toggle = screen.getByRole('button', { name: 'Snoozed · 1' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Snoozed issue')).toBeNull()

    const returned = screen.getByText('Returned issue')
    expect(returned.closest('[data-drag-key="returned"]')).toBeTruthy()
    expect(
      returned.closest('[data-testid=unified-issue-row]')?.querySelector('[data-testid=row-grip]'),
    ).toBeTruthy()

    fireEvent.click(toggle)
    const foldedRow = screen.getByTestId('snoozed-fold-row')
    expect(screen.getByText('Snoozed issue')).toBeTruthy()
    expect(foldedRow.className).toContain('row-arrive')
    expect(foldedRow.querySelector('[data-drag-key]')).toBeNull()
    expect(foldedRow.querySelector('[data-testid=row-grip]')).toBeNull()

    fireEvent.animationEnd(foldedRow, { animationName: 'podium-arrive-wash' })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(screen.getByTestId('snoozed-fold-row').className).toContain('row-arrive')
  })

  it('archives a closed issue from its hover/focus action', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive POD-42' }))
    expect(archiveMutate).toHaveBeenCalledWith({ id: 'closed' })
  })
})
