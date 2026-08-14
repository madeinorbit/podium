// @vitest-environment happy-dom
/**
 * THE WORKLIST IS FLAT (POD-516 §1.1).
 *
 * The operator clicked through the preview and said column 1 was unchanged: it
 * still showed subagents and subtasks with foldable items under each entry. The
 * approved artifact's `renderWork` emits a flat list of mission roots plus two
 * group folds and nothing else, and the doctrine says why — "a session is shown
 * directly beneath the issue it belongs to; its spawn parent and native workers
 * are secondary details, NOT a competing navigation tree".
 *
 * So these four facts are the contract, and each is a thing that was wrong:
 *   1. one row per mission, no children, no bands, no per-row disclosure;
 *   2. attention still bubbles up from a descendant, in words;
 *   3. the fleet stack carries real harness kinds, the live total and `×N`;
 *   4. the only foldable things left are group headers.
 *
 * Round 2 cut one of those group headers: the operator does not want a Proposed
 * section in this column, so the tucked-away (Closed) and suspended (Snoozed)
 * folds are all that remain.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closedFoldKey } from './fold-keys'
import { SidebarUnified } from './SidebarUnified'

/**
 * A REAL ui-state collection, not a `get: () => null` stub — the fold tests below
 * turn on the difference between reading the store once and subscribing to it.
 * `hydrate` is the case that matters: a per-user replicated row arriving over the
 * wire AFTER first render, which is what a reload actually looks like.
 */
const ui = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    get: (key: string): string | null => rows.get(key) ?? null,
    set: (key: string, value: string | null): void => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
      notify()
    },
    subscribe: (callback: () => void): (() => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    /** The replica landing late. */
    hydrate: (key: string, value: string): void => {
      rows.set(key, value)
      notify()
    },
    reset: (): void => rows.clear(),
  }
})

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

/** A session parked on a question — `motionPhase` reads this as `waiting`. */
const asking = {
  agentState: { phase: 'idle', idle: { kind: 'question' }, since: '2026-07-06T12:00:00.000Z' },
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

// One mission: a root, one child task under it, and a grandchild the child's
// agent started. Three harness kinds across five sessions, one of them running
// native subagents, and one parked on a question two levels down. Plus a
// proposed issue nobody has accepted and a tucked closure.
const SESSIONS = [
  sess('lead', 'root'),
  sess('spine', 'child', { agentKind: 'codex' }),
  // A spawn CHILD of `spine`: the old sidebar nested this under it.
  sess('spine-helper', 'child', {
    agentKind: 'codex',
    spawnedBy: 'session:spine',
    agentState: { phase: 'working', since: '2026-07-06T12:00:00.000Z', nativeSubagentCount: 3 },
  }),
  sess('tree', 'grandchild', { agentKind: 'cursor' }),
  sess('inspect', 'grandchild', { ...asking }),
  // The memory reaper parked this one (POD-756). It is still on `solo`.
  sess('napping', 'solo', {
    agentKind: 'grok',
    status: 'hibernated',
    agentState: { phase: 'idle', since: '2026-07-06T12:00:00.000Z' },
  }),
]

const ISSUES = [
  issue('root', 'Operator workspace', { childCount: 1, color: 'violet' }),
  issue('child', 'Flight deck spine', { parentId: 'root', seq: 2 }),
  issue('grandchild', 'Task inspector', { parentId: 'child', seq: 3 }),
  issue('solo', 'Sidebar unread dot', { seq: 4 }),
  issue('proposal', 'Review captures', { stage: 'proposed', seq: 5 }),
  issue('shut', 'Balanced desktop shell', {
    seq: 6,
    stage: 'done',
    closedReason: 'done',
    closedAt: '2026-07-01T00:00:00.000Z',
    tuckedAt: '2026-07-01T01:00:00.000Z',
  }),
]

vi.mock('@/app/store', () => {
  const useStore = () => ({
    uiState: ui,
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: SESSIONS,
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: ISSUES,
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

afterEach(() => {
  cleanup()
  ui.reset()
})

const missionRow = (): HTMLElement =>
  screen.getByText('Operator workspace').closest('[data-testid="unified-issue-row"]') as HTMLElement

describe('the worklist is one flat row per mission (POD-516 §1.1)', () => {
  it('renders mission roots only — no child issues, sessions or native subagents', () => {
    render(<SidebarUnified />)
    // Two live rows: the mission and the standalone task. The mission's child,
    // grandchild and every session belong to the Flight Deck, not here.
    const titles = screen
      .getAllByTestId('unified-issue-row')
      .map((row) => row.querySelector('.shell-work-row-title')?.textContent)
      .sort()
    expect(titles).toEqual(['Operator workspace', 'Sidebar unread dot'])
    expect(screen.queryByText('Flight deck spine')).toBeNull()
    expect(screen.queryByText('Task inspector')).toBeNull()
    for (const name of ['lead', 'spine', 'spine-helper', 'tree', 'inspect']) {
      expect(screen.queryByText(name)).toBeNull()
    }
    // The constructs the operator saw, by name.
    expect(screen.queryByTestId('agent-roster-band')).toBeNull()
    expect(screen.queryByTestId('session-group')).toBeNull()
    expect(screen.queryByTestId('native-subagent-indicator')).toBeNull()
    expect(screen.queryByTestId('started-by-children')).toBeNull()
    expect(screen.queryByTestId('subtree-rollup')).toBeNull()
    // F11: no second progress surface here — subtree progress is the Flight
    // Deck mission head's, one column right.
    expect(screen.queryByTestId('mission-subtree-progress')).toBeNull()
  })

  it('gives no row a disclosure of its own', () => {
    render(<SidebarUnified />)
    const rowToggles = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? '')
      .filter((label) => /^(Expand|Collapse) /.test(label))
    expect(rowToggles).toEqual([])
  })

  it('bubbles a descendant ask up to the mission row, in words', () => {
    render(<SidebarUnified />)
    // The question is on a grandchild's session; nothing below the mission row
    // renders, so the row has to say it itself.
    // The status line names WHERE, since no visible row can explain it, and it
    // is the row's ONE amber voice (POD-1057): the boxed `Needs you` pill that
    // used to sit on line 1 saying the same thing is gone.
    const status = missionRow().querySelector('[data-testid="row-lifecycle-status"]') as HTMLElement
    expect(status.textContent).toContain('deep: #3 needs you')
    // The ochre is on the PHRASE, not the whole line: the trailing facts (git,
    // the spin-off tick) must not inherit an ask they are not part of.
    expect(
      status.querySelector<HTMLElement>('[data-testid="row-status-phrase"]')?.style.color,
    ).toBe('var(--attention)')
    expect(missionRow().querySelector('[data-testid="need-pill"]')).toBeNull()
    // One ask, so no count leads the sentence.
    expect(missionRow().querySelector('[data-testid="need-count"]')).toBeNull()
    // A mission with nothing asked of the human says nothing in amber at all.
    const solo = screen
      .getByText('Sidebar unread dot')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    const soloStatus = solo.querySelector('[data-testid="row-lifecycle-status"]') as HTMLElement
    expect(
      soloStatus.querySelector<HTMLElement>('[data-testid="row-status-phrase"]')?.style.color,
    ).not.toBe('var(--attention)')
  })

  it('stacks real harness kinds with the agent total and the native-child count', () => {
    render(<SidebarUnified />)
    const fleet = missionRow().querySelector('[data-testid="issue-fleet-summary"]') as HTMLElement
    // KINDS, not agents: five sessions across three harnesses is three tiles.
    expect(
      [...fleet.querySelectorAll('[data-agent-kind]')].map((tile) =>
        tile.getAttribute('data-agent-kind'),
      ),
    ).toEqual(['claude-code', 'codex', 'cursor'])
    expect(fleet.querySelector('[data-testid="issue-fleet-total"]')?.textContent).toBe('5')
    expect(fleet.querySelector('[data-testid="issue-fleet-subagent-count"]')?.textContent).toBe(
      '×3',
    )
    expect(fleet.getAttribute('title')).toBe('5 agents · 3 native children')
  })

  it('keeps a PARKED agent on its issue, ghosted (POD-756)', () => {
    render(<SidebarUnified />)
    // `solo`'s only agent is hibernated: Podium stopped its process to reclaim
    // memory, which says nothing about who is on the task. The row used to drop
    // it and render no stack at all — the state every Codex agent in the fleet
    // was in.
    const solo = screen
      .getByText('Sidebar unread dot')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    const fleet = solo.querySelector('[data-testid="issue-fleet-summary"]') as HTMLElement
    const tile = fleet.querySelector('[data-agent-kind="grok"]') as HTMLElement
    expect(tile.getAttribute('data-parked')).toBe('')
    // Ghosted. In the work row's glyph variant (POD-1057) the marks carry no
    // tint of their own, so parked is said by ink alone rather than by swapping
    // the harness's tile pair.
    expect(fleet.getAttribute('data-variant')).toBe('glyphs')
    expect(tile.className).toContain('opacity-45')
    // A lone agent shows its tile and no total — the number would say nothing.
    expect(fleet.querySelector('[data-testid="issue-fleet-total"]')).toBeNull()
    expect(fleet.getAttribute('title')).toBe('1 agent · 1 parked')
  })

  it('ends the column with the tucked-away fold, and folds only bands', () => {
    render(<SidebarUnified />)
    const closed = screen.getByTestId('closed-fold-toggle')
    // The tail fold leads with the QUANTITY (POD-1057): what you are deciding
    // about is whether the pile is worth opening.
    expect(closed.textContent).toContain('1 closed')
    expect(closed.getAttribute('aria-expanded')).toBe('false')
    // WHAT MAY FOLD, EXHAUSTIVELY: the section bands (POD-1057 made every one of
    // them a header you can shut) and the column's tail fold. No ROW has a
    // disclosure of its own — that is the tree this column refuses to grow.
    const foldables = screen
      .getAllByRole('button')
      .filter(
        (button) => button.hasAttribute('aria-expanded') && !button.hasAttribute('aria-haspopup'),
      )
    expect(foldables).toContain(closed)
    for (const button of foldables) {
      const testId = button.getAttribute('data-testid')
      expect([
        'project-group-label',
        'pinned-section-label',
        'closed-fold-toggle',
        'snoozed-fold-toggle',
      ]).toContain(testId)
    }
  })

  /**
   * ROUND 2, LEFT SIDEBAR ITEM 3 — "dont put proposed section in here. not
   * needed! we only have the tucked away stuff + suspended."
   *
   * Round 1 added a Proposed fold, derived in this component from the raw issue
   * list because the worklist slice drops `stage === 'proposed'` at the row
   * level. Removing the fold therefore has to remove untriaged work from the
   * column ENTIRELY — the test that matters is not "the toggle is gone" but
   * "the proposal itself is nowhere", including as an ordinary row leaking back
   * in through some other path.
   */
  it('shows no proposed work anywhere in the column', () => {
    render(<SidebarUnified />)
    expect(screen.queryByTestId('proposed-fold-toggle')).toBeNull()
    expect(screen.queryByTestId('proposed-issue-fold')).toBeNull()
    expect(screen.queryByText('Review captures')).toBeNull()
    // Not hiding in the two folds that remain, either.
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    expect(screen.queryByText('Review captures')).toBeNull()
    expect(screen.queryByTestId('snoozed-fold-toggle')).toBeNull()
  })

  // POD-540. The fold keys are per-user REPLICATED (that is what the
  // `podium:sidebar:` spelling buys, see fold-keys.ts), so the row arrives over
  // the wire after first render. `useCollapsed` used to seed itself from a
  // `useState` initializer, which read null, fell back to the default and never
  // ran again — so every fold in this column came back closed on reload however
  // you left it. Now that the group folds are the ONLY foldable things here,
  // that bug is the whole of the column's memory.
  it('restores a fold from replicated layout state that lands after mount', () => {
    render(<SidebarUnified />)
    const toggle = () => screen.getByTestId('closed-fold-toggle')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    act(() => ui.hydrate(closedFoldKey('/repo'), 'false'))

    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('closed-fold-row')).toHaveLength(1)
  })

  it('writes a fold through the store rather than holding it in local state', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    // The press wrote; the value came back through the subscription. One source
    // of truth, so the rendered fold and the stored row cannot diverge.
    expect(ui.get(closedFoldKey('/repo'))).toBe('false')
    expect(screen.getByTestId('closed-fold-toggle').getAttribute('aria-expanded')).toBe('true')
  })
})
