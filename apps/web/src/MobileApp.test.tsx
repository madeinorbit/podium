// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from './MobileApp'

// #227: the mobile home view IS the sidebar work list (not the Command center),
// and the header's one dropdown lists every panel of the SELECTED ISSUE —
// sessions (agents and shells) plus the file tabs open on its worktree.

const setPane = vi.fn()
const setView = vi.fn()

function sess(id: string, over: Record<string, unknown> = {}) {
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
    issueId: 'iss',
    busy: false,
    readAt: null,
    unread: false,
    agentState: { phase: 'idle', idle: { kind: 'done' } },
    ...over,
  }
}

const issue = {
  id: 'iss',
  repoPath: '/repo',
  seq: 1,
  title: 'Selected issue',
  description: '',
  stage: 'in_progress',
  worktreePath: '/repo',
  branch: 'main',
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
  readAt: null,
  unread: false,
}

// Mutable across tests: the view the shell is on, and what's selected.
const state = { view: 'home' as string, selectedIssueId: null as string | null }

vi.mock('./store', () => {
  const useStore = () => ({
    setSearchOpen: vi.fn(),
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    reposLoading: false,
    repoDiagnostics: [],
    sessions: [sess('agent-one'), sess('shell-one', { agentKind: 'shell' })],
    machines: [],
    issues: [issue],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    trpc: {
      settings: { get: { query: vi.fn(async () => ({ roles: {} })) } },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
    },
    selectedWorktree: '/repo',
    setSelectedWorktree: vi.fn(),
    selectedIssueId: state.selectedIssueId,
    setSelectedIssueId: vi.fn(),
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane,
    fileTabs: [
      { id: 'file:s:/repo/notes.md', scope: {}, path: '/repo/notes.md', worktreePath: '/repo' },
    ],
    closeFileTab: vi.fn(),
    tabOrders: {},
    view: state.view,
    setView,
    superOpen: false,
    setSuperOpen: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    spawnDraftAgent: vi.fn(),
    markIssueRead: vi.fn(async () => {}),
    markIssueUnread: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}),
    markSessionUnread: vi.fn(async () => {}),
  })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

// The outlet's own switch is trivial; here we only need home-vs-workspace.
vi.mock('./routes', () => ({
  MainViewOutlet: ({ home, workspace }: { home?: unknown; workspace: unknown }) => (
    <>{state.view === 'home' ? home : workspace}</>
  ),
}))
vi.mock('./AgentPanel', () => ({ AgentPanel: () => <div>agent panel</div> }))
vi.mock('./SuperagentView', () => ({ SuperagentView: () => null }))
vi.mock('./HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('./NewPanelMenu', () => ({ NewPanelMenu: () => null, NEW_AGENTS: [] }))
vi.mock('@/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  state.view = 'home'
  state.selectedIssueId = null
})

describe('MobileApp home view (#227)', () => {
  it('shows the sidebar work list, not the command center', () => {
    render(<MobileApp />)
    expect(screen.getByText('WORK')).toBeTruthy()
    expect(screen.getByText('Selected issue')).toBeTruthy()
    expect(screen.queryByText('Command center')).toBeNull()
  })

  it('offers the app tools the retired worktree sheet used to hold', () => {
    render(<MobileApp />)
    for (const label of ['Usage & analytics', 'Settings', 'Search conversations', 'Add repo']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
  })
})

describe('MobileApp panel dropdown (#227)', () => {
  it("lists the selected issue's sessions, shells and file tabs", () => {
    state.view = 'workspace'
    state.selectedIssueId = 'iss'
    render(<MobileApp />)
    fireEvent.click(screen.getByLabelText('Select panel'))
    expect(screen.getByText('agent-one')).toBeTruthy()
    expect(screen.getByText('shell-one')).toBeTruthy()
    expect(screen.getByText('notes.md')).toBeTruthy()
  })

  it('opening a file panel sets the pane and returns to the workspace', () => {
    state.view = 'workspace'
    state.selectedIssueId = 'iss'
    render(<MobileApp />)
    fireEvent.click(screen.getByLabelText('Select panel'))
    fireEvent.click(screen.getByText('notes.md'))
    expect(setPane).toHaveBeenCalledWith('A', 'file:s:/repo/notes.md')
    expect(setView).toHaveBeenCalledWith('workspace')
  })

  it('titles the dropdown with the selected issue', () => {
    state.view = 'workspace'
    state.selectedIssueId = 'iss'
    render(<MobileApp />)
    expect(screen.getByLabelText('Select panel').textContent).toContain('Selected issue')
  })
})
