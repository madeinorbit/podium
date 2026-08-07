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
 * one still in backlog — beside a standalone task with no subtree at all, and a
 * closure the operator has already tucked away.
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

const meterOf = (container: HTMLElement, issueId: string): HTMLElement | null =>
  container.querySelector(`[data-issue-row="${issueId}"] [data-testid="row-progress"]`)

const widthsOf = (meter: HTMLElement): number[] =>
  [...(meter.children as unknown as HTMLElement[])].map((segment) =>
    Number.parseFloat(segment.style.width),
  )

describe('per-entry progress in the worklist (POD-516 round 3)', () => {
  it('no longer summarises the whole column above the first row', () => {
    setUp([sess('lead', 'root')])
    const view = render(<SidebarUnified />)
    expect(screen.queryByTestId('worklist-status')).toBeNull()
    expect(view.container.querySelector('[data-testid="worklist-status-meter"]')).toBeNull()
  })

  it.each([
    // The row speaks for its whole mission, so a subtree with no rows of its
    // own is still what the meter measures.
    { id: 'root', why: 'a five-task mission', meter: true },
    // One issue, one agent: 0% until it is 100%, which the status word already
    // says in a word. "if it makes sense" — this does not.
    { id: 'solo', why: 'one issue with no subtree', meter: false },
  ])('$why → meter: $meter', ({ id, meter }) => {
    setUp([sess('lead', 'root')])
    const view = render(<SidebarUnified />)
    expect(view.container.querySelector(`[data-issue-row="${id}"]`)).toBeTruthy()
    expect(meterOf(view.container, id) !== null).toBe(meter)
  })

  it('draws exclusive buckets that cannot exceed the bar', () => {
    setUp([sess('lead', 'root')])
    const view = render(<SidebarUnified />)
    const meter = meterOf(view.container, 'root') as HTMLElement
    expect(meter.getAttribute('data-total')).toBe('5')
    // Two lit segments — done, then running — over the trough: two children
    // done and the in-progress root running. The blocked child and the backlog
    // child are both NOT MOVING and stay in the trough, where the tooltip still
    // accounts for them.
    expect(widthsOf(meter)).toEqual([(2 / 5) * 100, (1 / 5) * 100])
    expect(widthsOf(meter).reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(100)
    expect(meter.getAttribute('aria-label')).toBe(
      '5 tasks · 2 done · 1 running · 1 blocked · 1 waiting',
    )
  })

  it('sweeps the running segment only while an agent is actually computing', () => {
    // The task is `in_progress` and its agent has stopped: the run segment keeps
    // its colour (the task IS running) but nothing moves — stillness is signal.
    setUp([
      sess('lead', 'root', { agentState: { phase: 'idle', since: '2026-07-06T12:00:00.000Z' } }),
    ])
    const idle = render(<SidebarUnified />)
    const parked = meterOf(idle.container, 'root') as HTMLElement
    expect(parked.getAttribute('data-working')).toBe('false')
    expect(parked.querySelector('.row-progress-sweep')).toBeNull()
    expect(widthsOf(parked)[1]).toBe((1 / 5) * 100)
    cleanup()

    setUp([sess('lead', 'root')])
    const live = render(<SidebarUnified />)
    const moving = meterOf(live.container, 'root') as HTMLElement
    expect(moving.getAttribute('data-working')).toBe('true')
    expect(moving.querySelector('.row-progress-sweep')).toBeTruthy()
  })

  it('spends no amber on the meter — colour is reserved for what needs you', () => {
    setUp([sess('lead', 'root')])
    const view = render(<SidebarUnified />)
    const meter = meterOf(view.container, 'root') as HTMLElement
    const classes = [meter, ...meter.querySelectorAll('*')].flatMap((node) => [...node.classList])
    for (const banned of ['bg-attention', 'text-attention', 'bg-warning', 'text-warning']) {
      expect(classes).not.toContain(banned)
    }
  })
})
