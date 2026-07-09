// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// Read/mark spies shared between the mocked store and the assertions. vi.hoisted
// makes them available inside the hoisted vi.mock factory below.
const { markIssueRead, markIssueUnread, markSessionRead, markSessionUnread, deferMutate } =
  vi.hoisted(() => ({
    markIssueRead: vi.fn(async () => {}),
    markIssueUnread: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}),
    markSessionUnread: vi.fn(async () => {}),
    deferMutate: vi.fn(async () => ({})),
  }))

// An idle (finished) session keeps its issue in WORK (not lifted to WORKING).
function idleSess(id: string, issueId: string) {
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
    readAt: null,
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
    readAt: null,
    unread: false,
    ...over,
  }
}

vi.mock('./store', () => {
  const useStore = () => ({
    setSearchOpen: vi.fn(),
    // ui-state collection (persisted section collapse etc.) — absent key = default.
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [
      idleSess('s-unread', 'u1'),
      idleSess('s-read', 'r1'),
      idleSess('s-defer', 'd1'),
    ],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      issue('u1', 'Unread issue', { unread: true }),
      issue('r1', 'Read issue', { unread: false }),
      // A returned-from-defer issue: deferUntil in the PAST (undefer backdated it),
      // so it reads as "Unsnoozed" until opened (FIX C).
      issue('d1', 'Unsnoozed issue', {
        unread: false,
        deferUntil: '2020-01-01T00:00:00.000Z',
        deferred: false,
      }),
    ],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: deferMutate } },
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
    spawnDraftAgent: vi.fn(),
    markIssueRead,
    markIssueUnread,
    markSessionRead,
    markSessionUnread,
  })
  // The selector-store hook (refactor) reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('./HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  markIssueRead.mockClear()
  markIssueUnread.mockClear()
  markSessionRead.mockClear()
  markSessionUnread.mockClear()
  deferMutate.mockClear()
})

describe('SidebarUnified unread emphasis + mark-read-on-open', () => {
  it('renders an unread issue row at medium weight and a read one at normal weight', () => {
    render(<SidebarUnified />)
    expect(screen.getByText('Unread issue').className).toContain('font-medium')
    expect(screen.getByText('Read issue').className).not.toContain('font-medium')
  })

  it('marks the issue read when its row is opened', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByText('Unread issue'))
    expect(markIssueRead).toHaveBeenCalledWith('u1')
  })

  it('right-clicking a READ issue offers "Mark as unread" and calls markIssueUnread (#138)', () => {
    render(<SidebarUnified />)
    fireEvent.contextMenu(screen.getByText('Read issue'))
    fireEvent.click(screen.getByText('Mark as unread'))
    expect(markIssueUnread).toHaveBeenCalledWith('r1')
  })

  it('right-clicking an UNREAD issue offers "Mark as read" and calls markIssueRead (#138)', () => {
    render(<SidebarUnified />)
    fireEvent.contextMenu(screen.getByText('Unread issue'))
    fireEvent.click(screen.getByText('Mark as read'))
    expect(markIssueRead).toHaveBeenCalledWith('u1')
  })

  it('opening an unsnoozed issue clears its "Unsnoozed" tag via defer(null) (#138 FIX C)', () => {
    render(<SidebarUnified />)
    // The tag renders while deferUntil is in the past…
    expect(screen.getByText('Unsnoozed')).toBeTruthy()
    fireEvent.click(screen.getByText('Unsnoozed issue'))
    // …and opening the issue nulls deferUntil so the tag source is gone.
    expect(deferMutate).toHaveBeenCalledWith({ id: 'd1', until: null })
  })
})
