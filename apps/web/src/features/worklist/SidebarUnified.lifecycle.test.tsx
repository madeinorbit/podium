// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// A live ui-state collection (POD-540): the worklist's group folds SUBSCRIBE to
// their per-user replicated row rather than seeding local state, so a `set` that
// stores nothing means the fold never opens. Backed by a Map so a press writes
// and the value comes back through the subscription, as in the real store.
const ui = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    get: (key: string): string | null => rows.get(key) ?? null,
    set: (key: string, value: string | null): void => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
      for (const listener of listeners) listener()
    },
    subscribe: (callback: () => void): (() => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    reset: (): void => rows.clear(),
  }
})

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
    blockedByNotes: [],
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
  const closedSecond = {
    ...closed,
    id: 'closed-second',
    seq: 45,
    displayRef: 'POD-45',
    title: 'Another settled issue',
    closedAt: '2026-07-22T10:00:00.000Z',
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
    uiState: ui,
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [closed, closedSecond, snoozed, returned],
    trpc: {
      settings: {
        get: {
          query: vi.fn(async () => ({ sessionDefaults: { agent: 'codex' } })),
        },
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

vi.mock('@/features/machines/HostIndicators', () => ({
  HostIndicators: () => null,
}))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  ui.reset()
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
    const archiveButton = screen.getByRole('button', {
      name: 'Archive POD-42',
    })
    fireEvent.click(archiveButton)
    expect(archiveMutate).toHaveBeenCalledWith({ id: 'closed' })
    expect(archiveButton.querySelector('svg')?.getAttribute('class')).toContain('opacity-0')
    expect(archiveButton).toHaveProperty('disabled', true)
  })

  it('archives every closed issue from the fold title action', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByRole('button', { name: 'Archive all 2 closed issues' }))

    expect(archiveMutate).toHaveBeenCalledTimes(2)
    expect(archiveMutate).toHaveBeenCalledWith({ id: 'closed' })
    expect(archiveMutate).toHaveBeenCalledWith({ id: 'closed-second' })
  })
})
