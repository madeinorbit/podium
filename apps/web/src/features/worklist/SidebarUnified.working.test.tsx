// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// A minimal session shaped like the wire; `phase` drives isSessionWorking.
function sess(id: string, issueId: string, phase: 'working' | 'idle') {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    cwd: '/repo',
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
    agentState:
      phase === 'working' ? { phase: 'working' } : { phase: 'idle', idle: { kind: 'done' } },
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
    ...over,
  }
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    setSearchOpen: vi.fn(),
    // ui-state collection (persisted section collapse etc.) — absent key = default.
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [
      sess('s-work', 'fully', 'working'), // fully-working issue → WORKING
      sess('s-run', 'partial', 'working'), // partial: lifted to WORKING
      sess('s-idle', 'partial', 'idle'), // partial: stays in WORK
    ],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [issue('fully', 'Fully working issue'), issue('partial', 'Partly working issue')],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
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
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
  })
  // The selector-store hook (refactor) reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
// PanelRow (the lifted working session) pulls in the session guard, which needs a
// ConfirmProvider — stub it so the row renders without the provider tree.
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(cleanup)

describe('SidebarUnified WORKING move-out', () => {
  it('renders a WORKING section holding the fully-working issue and the lifted session', () => {
    render(<SidebarUnified />)
    // The WORKING section header renders (a fully-working issue + a lifted session).
    const workingHeader = screen.getByRole('button', { name: /Collapse WORKING|Expand WORKING/ })
    expect(workingHeader).toBeTruthy()
    // The fully-working issue moved into the sidebar; the partial one stays too.
    expect(screen.getByText('Fully working issue')).toBeTruthy()
    expect(screen.getByText('Partly working issue')).toBeTruthy()
  })

  it('keeps the partially-working issue in WORK, not WORKING', () => {
    render(<SidebarUnified />)
    // WORK header is present alongside WORKING (partial issue lives there).
    expect(screen.getByText('WORK')).toBeTruthy()
    // The idle child session of the partial issue is what keeps it in WORK — the
    // partial issue title renders exactly once (one row, not duplicated).
    expect(screen.getAllByText('Partly working issue')).toHaveLength(1)
  })
})
