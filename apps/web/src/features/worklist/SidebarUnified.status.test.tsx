// @vitest-environment happy-dom
/**
 * THE COLUMN'S STATUS LINE (POD-516 round 2, left sidebar items 1 and 2).
 *
 * "can we bring the dynamic status bar from the artifact? where we show how many
 * issues are done, waiting, progressing (with animation)".
 *
 * The three things that can go wrong here are the three things round 1 shipped
 * wrong, so they are what this file asserts:
 *
 *   1. THE NUMBERS AGREE WITH THE COLUMN. The bar is derived from the rendered
 *      rows' missions, so it counts subtasks that have no row of their own and
 *      does NOT count the closed work folded away below it. A summary that
 *      disagrees with the list it sits on top of is worse than no summary.
 *   2. THE SEGMENTS ADD UP. Four buckets over one bar; if a task could land in
 *      two of them the meter would run past 100%.
 *   3. THE SPINNER IS GATED ON REAL COMPUTATION. It is the only perpetual
 *      motion in the product (DESIGN.md §5) and it may not turn over a fleet
 *      that has stopped — a task can sit in `in_progress` all night with
 *      nothing running.
 *
 * And one rule from the branch: MOTION FOR ACTIVITY, COLOUR FOR OBLIGATION.
 * Amber means an agent is asking you something. A progress meter asks nothing,
 * so nothing in this row may be amber.
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
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(cleanup)

/**
 * One mission of five tasks — root in progress, two children done, one blocked,
 * one still in backlog — plus a standalone task, plus a closure the operator
 * has already tucked away. Six live tasks in the column's scope; the tucked one
 * must not join them.
 */
const MISSION = [
  issue('root', 'Operator workspace', { childCount: 3 }),
  issue('a', 'Flight deck spine', { parentId: 'root', seq: 2, stage: 'done' }),
  issue('b', 'Task inspector', { parentId: 'root', seq: 3, stage: 'done' }),
  issue('c', 'Native lifecycle', { parentId: 'root', seq: 4, blocked: true, ready: false }),
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

const meterWidths = (): string[] =>
  [...(screen.getByTestId('worklist-status-meter').children as unknown as HTMLElement[])].map(
    (segment) => segment.style.width,
  )

describe('the worklist status line (POD-516 round 2)', () => {
  it('counts every task in the column, including ones with no row of their own', () => {
    setUp([sess('lead', 'root')])
    render(<SidebarUnified />)
    // Two rows on screen; six live tasks behind them. The mission's four
    // subtasks are real work even though the flat column gives them no row.
    expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(2)
    expect(screen.getByTestId('worklist-status-done').textContent).toBe('2/6 done')
    // `in_progress` root + `in_progress` solo. `backlog` waits, blocked is its
    // own bucket, and the tucked closure is not in the column at all.
    expect(screen.getByTestId('worklist-status-run').textContent).toContain('2 running')
    expect(screen.getByTestId('worklist-status')?.getAttribute('title')).toBe(
      '6 tasks · 2 done · 2 running · 1 blocked · 1 waiting',
    )
  })

  it('draws four exclusive buckets that cannot exceed the bar', () => {
    setUp([sess('lead', 'root')])
    render(<SidebarUnified />)
    const widths = meterWidths().map((width) => Number.parseFloat(width))
    // done · run · block, with waiting left as the bare trough.
    expect(widths).toEqual([(2 / 6) * 100, (2 / 6) * 100, (1 / 6) * 100])
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(100)
  })

  it('turns the spinner only while an agent is actually computing', () => {
    // A task in `in_progress` whose agent has stopped: the count still reads
    // "running" (the task is), but nothing moves — stillness is the signal.
    setUp([sess('lead', 'root', { agentState: { phase: 'idle', since: '2026-07-06T12:00:00.000Z' } })])
    const idle = render(<SidebarUnified />)
    expect(screen.getByTestId('worklist-status-run').getAttribute('data-working')).toBe('false')
    expect(idle.container.querySelector('.spb')).toBeNull()
    cleanup()

    setUp([sess('lead', 'root')])
    const live = render(<SidebarUnified />)
    expect(screen.getByTestId('worklist-status-run').getAttribute('data-working')).toBe('true')
    expect(live.container.querySelector('[data-testid="worklist-status"] .spb')).toBeTruthy()
  })

  it('does not turn the spinner for an agent outside the column', () => {
    // An exited session is gone, and a session on the tucked closure is not in
    // this column's scope. Neither may drive the column's one animation.
    setUp([
      sess('gone', 'root', { status: 'exited' }),
      sess('tucked', 'shut'),
    ])
    render(<SidebarUnified />)
    expect(screen.getByTestId('worklist-status-run').getAttribute('data-working')).toBe('false')
  })

  it('spends no amber on the meter — colour is reserved for what needs you', () => {
    setUp([sess('lead', 'root')])
    const view = render(<SidebarUnified />)
    const status = screen.getByTestId('worklist-status')
    const classes = [...status.querySelectorAll('*')].flatMap((node) => [...node.classList])
    for (const banned of ['bg-attention', 'text-attention', 'bg-warning', 'text-warning']) {
      expect(classes).not.toContain(banned)
    }
    // And no per-row meter came back with it: subtree progress belongs to the
    // Flight Deck's mission head, one column right (round 1, F11).
    expect(view.container.querySelectorAll('[data-testid="worklist-status-meter"]')).toHaveLength(1)
  })

  it('falls back to the plain spacer when the column has no tasks to summarise', () => {
    setUp([], [])
    render(<SidebarUnified />)
    expect(screen.queryByTestId('worklist-status')).toBeNull()
  })
})
