// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// One idle session per issue keeps rows in WORK (not lifted to WORKING).
function idleSess(id: string, issueId: string, cwd = '/repo') {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    cwd,
    title: id,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-06T12:00:00.000Z',
    lastActiveAt: '2026-07-06T12:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    issueId,
    busy: false,
    readAt: '2026-07-06T12:00:00.000Z',
    unread: false,
    agentState: { phase: 'idle', idle: { kind: 'done' } },
  }
}

function issue(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    repoPath: '/repo',
    seq: 1,
    title,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedBy: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
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
    readAt: '2026-06-20T00:00:00.000Z',
    unread: false,
    ...over,
  }
}

const createMutate = vi.fn(async () => ({ sessionId: 'new-shell-session' }))
const setPane = vi.fn()

// Issue 'wt' owns a worktree → gets the open-shell action; issue 'nowt' has none.
vi.mock('@/app/store', () => {
  const useStore = () => ({
    repos: [
      {
        path: '/repo',
        kind: 'repository',
        branch: 'main',
        worktrees: [{ path: '/repo/.worktrees/feat', branch: 'feat', isMain: false }],
      },
    ],
    sessions: [idleSess('s-wt', 'wt', '/repo/.worktrees/feat'), idleSess('s-nowt', 'nowt')],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      issue('wt', 'Issue with worktree', {
        worktreePath: '/repo/.worktrees/feat',
        branch: 'feat',
      }),
      issue('nowt', 'Issue without worktree'),
    ],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
      sessions: { create: { mutate: createMutate } },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: null,
    setSelectedIssueId: vi.fn(),
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane,
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    uiState: { get: () => null, set: () => {}, subscribe: () => () => {} },
    spawnDraftAgent: vi.fn(),
    markIssueRead: vi.fn(),
    markSessionRead: vi.fn(),
  })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  createMutate.mockClear()
  setPane.mockClear()
})

describe('sidebar row "open shell" action (#23)', () => {
  it('an issue row with a worktree offers the open-shell button; one without does not', () => {
    render(<SidebarUnified />)
    expect(screen.getByLabelText('Open shell in Issue with worktree')).toBeTruthy()
    expect(screen.queryByLabelText('Open shell in Issue without worktree')).toBeNull()
  })

  it('clicking it spawns a shell in that worktree attached to the issue, then focuses it', async () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByLabelText('Open shell in Issue with worktree'))
    await vi.waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1))
    expect(createMutate).toHaveBeenCalledWith({
      agentKind: 'shell',
      cwd: '/repo/.worktrees/feat',
      issueId: 'wt',
    })
    await vi.waitFor(() => expect(setPane).toHaveBeenCalledWith('A', 'new-shell-session'))
  })
})
