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
  const useStore = () => ({
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [closed],
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
    useStoreSelector: (selector: (state: unknown) => unknown) => selector(useStore() as never),
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
  it('archives a closed issue from its hover/focus action', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive POD-42' }))
    expect(archiveMutate).toHaveBeenCalledWith({ id: 'closed' })
  })
})
