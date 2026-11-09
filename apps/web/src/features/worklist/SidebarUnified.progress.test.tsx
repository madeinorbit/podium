import '@/test-support/mock-pool-fixture'
import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
/**
 * PER-ENTRY PROGRESS IN THE WORKLIST (POD-516 round 3, left sidebar).
 *
 * "left sidebar: i don't know what happened but there's now a overall progress
 *  section in the header of the sidebar. This was uncalled for. what i want is
 *  a progress bar or another graphically smart progress indicator PER sidebar
 *  entry (if it makes sense e.g. multiple issues or progress known). the
 *  working part of the bar can be animated"
 *
 * Four things can go wrong here, and they are what this file asserts:
 *
 *   1. THE COLUMN-WIDE INSTRUMENT IS GONE. Round 2's "N/M done · K running"
 *      meter above the first row was cut by name.
 *   2. THE METER EARNS ITS PLACE. A row speaking for a real subtree gets one; a
 *      row that is one issue does not, because a bar that can only read 0% or
 *      100% is noise on a list of thirty rows. ("if it makes sense.")
 *   3. THE SEGMENTS ADD UP. Four exclusive buckets over one bar, so it can
 *      never run past 100%.
 *   4. MOTION MEANS AN AGENT IS COMPUTING. The running segment sweeps under the
 *      same gate as the braille spinner — never merely because a task is parked
 *      in `in_progress` — and nothing in the meter is amber, because a progress
 *      meter asks nothing of the operator (DESIGN.md §2).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

const ui = vi.hoisted(() => ({
  get: (): string | null => null,
  set: (): void => {},
  subscribe: (): (() => void) => () => {},
}))

const state = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  issues: [] as Record<string, unknown>[],
}))

function sess(
  id: string,
  issueId: string | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
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
    agentState: { phase: 'working', since: '2026-07-06T12:00:00.000Z', nativeSubagentCount: 0 },
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
    blockedByNotes: [],
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

vi.mock('@/app/store', () => {
  const useStore = () => ({
    uiState: ui,
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: state.sessions,
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: state.issues,
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
    navigateWorkspace: vi.fn(() => true),
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    markIssueRead: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}),
    setIssueTucked: vi.fn(async () => {}),
  })
  return {
    useStore,
    readFixture: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(cleanup)

/**
 * One mission of five tasks — root in progress, two children done, one blocked,
 * one still in backlog — beside a standalone task with no subtree at all, and a
 * closure the operator has already tucked away.
 */
const MISSION = [
  issue('root', 'Operator workspace', { childCount: 3 }),
  issue('a', 'Flight deck spine', { parentId: 'root', seq: 2, stage: 'done' }),
  issue('b', 'Task inspector', { parentId: 'root', seq: 3, stage: 'done' }),
  issue('c', 'Native lifecycle', {
    parentId: 'root',
    seq: 4,
    deps: [{ id: 'solo', type: 'blocked-by' }],
    blocked: true,
    ready: false,
  }),
  issue('d', 'Row renderer', { parentId: 'root', seq: 5, stage: 'backlog' }),
  issue('solo', 'Sidebar unread dot', { seq: 6 }),
  issue('shut', 'Balanced desktop shell', {
    seq: 7,
    stage: 'done',
    closedReason: 'done',
    closedAt: '2026-07-01T00:00:00.000Z',
    tuckedAt: '2026-07-01T01:00:00.000Z',
  }),
]

const setUp = (sessions: Record<string, unknown>[], issues = MISSION): void => {
  state.sessions = sessions
  state.issues = issues
}

const meterOf = (container: HTMLElement, issueId: string): HTMLElement | null =>
  container.querySelector(`[data-issue-row="${issueId}"] [data-testid="row-progress"]`)

describe('per-entry progress in the worklist (POD-516 round 3)', () => {
  it('no longer summarises the whole column above the first row', () => {
    setUp([sess('lead', 'root')])
    const view = render(<SidebarUnified />)
    expect(screen.queryByTestId('worklist-status')).toBeNull()
    expect(view.container.querySelector('[data-testid="worklist-status-meter"]')).toBeNull()
  })

  // THE CALM ROWS (POD-2074) DRAW NO BAR. The per-row meter was the loudest
  // repeated mark in the column; a mission now tallies its tasks as one quiet
  // fact on line 2, and a lone issue, whose tally would only say 0/1 or 1/1,
  // says nothing.
  it('tallies a mission on line 2 instead of drawing a per-row bar', () => {
    setUp([sess('lead', 'root')])
    const view = render(<SidebarUnified />)
    expect(meterOf(view.container, 'root')).toBeNull()
    const status = (id: string) =>
      view.container.querySelector(`[data-issue-row="${id}"] [data-testid="row-lifecycle-status"]`)
        ?.textContent ?? ''
    // FOUR tasks, not five: POD-710 stopped counting the mission root beside
    // its own members.
    expect(status('root')).toContain('2/4')
    expect(status('solo')).not.toMatch(/\d+\/\d+/)
  })

  it('spends no amber on the tally — colour is reserved for what needs you', () => {
    setUp([sess('lead', 'root')])
    const view = render(<SidebarUnified />)
    const status = view.container.querySelector(
      '[data-issue-row="root"] [data-testid="row-lifecycle-status"]',
    ) as HTMLElement
    expect(status.getAttribute('data-tone')).not.toBe('needs')
  })
})
