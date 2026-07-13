// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// FIX B (#138): rows rendered under WORKING — fully-working issues/worktrees AND
// the individual working sessions lifted out of partially-working rows — must
// NOT carry the bold unread emphasis. "Working" = actively in progress, not new
// unseen work. Unread emphasis still applies in WORK (and PINNED).

function sess(
  id: string,
  issueId: string,
  phase: 'idle' | 'working',
  over: Record<string, unknown> = {},
) {
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
    agentState:
      phase === 'working'
        ? { phase: 'working', since: '2026-07-06T12:00:00.000Z', openTaskCount: 0 }
        : { phase: 'idle', idle: { kind: 'done' } },
    ...over,
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
    unread: true,
    ...over,
  }
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    // ui-state collection (persisted section collapse etc.) — absent key = default.
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [
      // 'wk' fully working → whole issue moves to WORKING.
      sess('s-wk', 'wk', 'working'),
      // 'wr' idle → stays in WORK (the unread-emphasis control).
      sess('s-wr', 'wr', 'idle'),
      // 'part' partially working → the working session lifts individually to WORKING.
      sess('working-child', 'part', 'working', { unread: true }),
      sess('idle-child', 'part', 'idle', { unread: true }),
      // 'pin' is pinned + fully working → EXEMPT from the WORKING move-out, so it
      // stays in WORK with its working children. Only the isSessionWorking gate
      // (not the WORKING-section suppressUnread prop) can mute these.
      sess('pin-a', 'pin', 'working', { unread: true }),
      sess('pin-b', 'pin', 'working', { unread: true }),
    ],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      issue('wk', 'Working issue', { unread: true }),
      issue('wr', 'Work issue', { unread: true }),
      issue('part', 'Partially working', { unread: true }),
      issue('pin', 'Pinned working', { unread: true, pinned: true }),
    ],
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
    spawnDraftAgent: vi.fn(),
    markIssueRead: vi.fn(async () => {}),
    markIssueUnread: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}),
    markSessionUnread: vi.fn(async () => {}),
  })
  // The selector-store hook (refactor) reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(cleanup)

describe('SidebarUnified WORKING rows suppress unread emphasis (#138 FIX B)', () => {
  it('a fully-working unread issue is not emphasized, while an idle unread issue in WORK is', () => {
    render(<SidebarUnified />)
    // Same issue, both unread — the only difference is WORKING vs WORK placement.
    expect(screen.getByText('Working issue').className).not.toContain('font-medium')
    expect(screen.getByText('Work issue').className).toContain('font-medium')
  })

  it('a working session lifted into WORKING is not emphasized', () => {
    render(<SidebarUnified />)
    const lifted = screen.getByText('working-child').closest('button')
    // A non-active unread PanelRow normally gets `font-medium text-foreground`;
    // under WORKING that emphasis is suppressed. `font-medium` is the tell (the
    // base row already carries `hover:text-foreground`, so text-foreground alone
    // isn't distinguishing).
    expect(lifted?.className).not.toContain('font-medium')
  })

  it('a currently-working session kept in WORK (pinned issue) is not emphasized', () => {
    render(<SidebarUnified />)
    // A working pinned issue renders in BOTH WORKING and WORK — neither copy of
    // its row label is emphasized…
    const labels = screen.getAllByText('Pinned working')
    expect(labels).toHaveLength(2)
    for (const l of labels) expect(l.className).not.toContain('font-medium')
    // …and its working child sessions are muted by the isSessionWorking gate,
    // even though suppressUnread is false on the WORK copy.
    for (const child of screen.getAllByText('pin-a'))
      expect(child.closest('button')?.className).not.toContain('font-medium')
  })
})
