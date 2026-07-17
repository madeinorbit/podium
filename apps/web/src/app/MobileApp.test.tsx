// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from './MobileApp'

// #227: the mobile home view IS the sidebar work list (not the Command center),
// and the header's one dropdown lists every panel of the SELECTED ISSUE —
// sessions (agents and shells) plus the file tabs open on its worktree.

const setPane = vi.fn()
const setView = vi.fn()
const setSuperOpen = vi.fn()

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

// Mutable across tests: the view the shell is on, what's selected, which pane
// is open, whether the superagent overlay is up, and the session set.
const state = {
  view: 'home' as string,
  selectedIssueId: null as string | null,
  paneA: null as string | null,
  superOpen: false,
  sessions: [sess('agent-one'), sess('shell-one', { agentKind: 'shell' })] as ReturnType<
    typeof sess
  >[],
}

vi.mock('./store', () => {
  const useStore = () => ({
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    reposLoading: false,
    repoDiagnostics: [],
    sessions: state.sessions,
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
    paneA: state.paneA,
    setPane,
    fileTabs: [
      { id: 'file:s:/repo/notes.md', scope: {}, path: '/repo/notes.md', worktreePath: '/repo' },
    ],
    closeFileTab: vi.fn(),
    tabOrders: {},
    view: state.view,
    setView,
    superOpen: state.superOpen,
    setSuperOpen,
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
vi.mock('@/features/terminal/AgentPanel', () => ({ AgentPanel: () => <div>agent panel</div> }))
vi.mock('@/features/superagent/SuperagentView', () => ({ SuperagentView: () => null }))
vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('./NewPanelMenu', () => ({ NewPanelMenu: () => null, NEW_AGENTS: [] }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  state.view = 'home'
  state.selectedIssueId = null
  state.paneA = null
  state.superOpen = false
  state.sessions = [sess('agent-one'), sess('shell-one', { agentKind: 'shell' })]
})

describe('MobileApp home view (#227)', () => {
  it('shows the sidebar work list, not the command center', () => {
    render(<MobileApp />)
    // #41: the WORK header gave way to always-on project group labels.
    expect(screen.getAllByTestId('project-group-label').length).toBeGreaterThan(0)
    expect(screen.getByText('Selected issue')).toBeTruthy()
    expect(screen.queryByText('Command center')).toBeNull()
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
})

describe('MobileApp redesigned header (#45, mobile.md §2.1)', () => {
  it('shows the ID square and a +N panel count that hides while the menu is open', () => {
    state.view = 'workspace'
    state.selectedIssueId = 'iss'
    state.paneA = 'agent-one'
    render(<MobileApp />)
    expect(screen.getByTestId('mobile-header-id-square')).toBeTruthy()
    const trigger = screen.getByLabelText('Select panel')
    // 3 panels of this work (agent, shell, file tab) minus the active one.
    expect(screen.getByTestId('mobile-panel-count').textContent).toBe('+2')
    fireEvent.click(trigger)
    expect(screen.queryByTestId('mobile-panel-count')).toBeNull()
    expect(screen.getByTestId('mobile-panel-menu')).toBeTruthy()
  })

  it('closes a default-open superagent at mount — mobile lands on Home (2a/2c)', () => {
    // The desktop column's persisted default is OPEN; inherited on mobile it
    // would bury the home list under the full-screen overlay on first load.
    state.superOpen = true
    render(<MobileApp />)
    expect(setSuperOpen).toHaveBeenCalledWith(false)
  })

  it('mounts the superagent overlay while the superagent is open', () => {
    state.view = 'workspace'
    state.selectedIssueId = 'iss'
    state.superOpen = true
    render(<MobileApp />)
    expect(screen.getByTestId('mobile-super-overlay')).toBeTruthy()
  })
})

describe('MobileApp panel-menu status grammar (#45, mobile.md §2.3)', () => {
  it('rows carry the agent-kind label and the working/waiting glyphs', () => {
    state.view = 'workspace'
    state.selectedIssueId = 'iss'
    state.paneA = 'agent-one'
    state.sessions = [
      sess('agent-one', { agentState: { phase: 'working', since: '', nativeSubagentCount: 0 } }),
      sess('agent-two', { agentState: { phase: 'needs_user', need: { kind: 'question' } } }),
    ]
    const { container } = render(<MobileApp />)
    fireEvent.click(screen.getByLabelText('Select panel'))
    const menu = screen.getByTestId('mobile-panel-menu')
    // Kind label: `· <icon> Claude` after the session name.
    expect(menu.textContent).toContain('Claude')
    // Working row → braille spinner; waiting row → amber pill.
    expect(container.querySelector('[data-testid="mobile-panel-menu"] .spb')).toBeTruthy()
    expect(screen.getByLabelText('waiting on you')).toBeTruthy()
  })
})
