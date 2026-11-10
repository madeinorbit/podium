import '@/test-support/mock-core-store-handle'
// POD-3911: exercise the real pool after the provider-free action fixture.
import '@/test-support/mock-pool-fixture'
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
import { projectFoldKey } from './fold-keys'
import { SidebarUnified } from './SidebarUnified'

/**
 * A REAL ui-state collection, not a `get: () => null` stub — the fold tests below
 * turn on the difference between reading the store once and subscribing to it.
 * `hydrate` is the case that matters: a per-user replicated row arriving over the
 * wire AFTER first render, which is what a reload actually looks like.
 */
const ui = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const notify = (key: string): void => {
    for (const listener of listeners) listener(new Set([key]))
  }
  return {
    get: (key: string): string | null => rows.get(key) ?? null,
    set: (key: string, value: string | null): void => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
      notify(key)
    },
    subscribe: (callback: (keys: ReadonlySet<string>) => void): (() => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    /** The replica landing late. */
    hydrate: (key: string, value: string): void => {
      rows.set(key, value)
      notify(key)
    },
    reset: (): void => rows.clear(),
  }
})

const fixture = vi.hoisted(() => ({ issues: null as Record<string, unknown>[] | null }))

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
  issue('root', 'Operator workspace', { childCount: 1 }),
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
    issues: fixture.issues ?? ISSUES,
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
    sidebarSettings: { },
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

afterEach(() => {
  cleanup()
  ui.reset()
  fixture.issues = null
})

const missionRow = (): HTMLElement =>
  screen.getByText('Operator workspace').closest('[data-testid="unified-issue-row"]') as HTMLElement

describe('the worklist is one flat row per mission (POD-516 §1.1)', () => {
  it('renders mission roots only — no child issues, sessions or native subagents', async () => {
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

  it('gives no row a disclosure of its own', async () => {
    render(<SidebarUnified />)
    const rowToggles = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? '')
      .filter((label) => /^(Expand|Collapse) /.test(label))
    expect(rowToggles).toEqual([])
  })

  it('keeps descendant attention without a redundant single-leaf tally', async () => {
    render(<SidebarUnified />)
    // A grandchild session is asking, so the row keeps its attention colour.
    const status = missionRow().querySelector('[data-testid="row-lifecycle-status"]') as HTMLElement
    // POD-2237 counts leaf tasks: root -> child -> grandchild is one unit.
    // The calm row (POD-2074) says the ask once and omits a redundant 0/1.
    expect(status.textContent).toContain('Waiting on you')
    expect(status.textContent).not.toMatch(/\d+\/\d+/)
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

  it.each([
    ['in_progress', '0/2'],
    ['done', '1/2'],
  ])('tallies a second %s leaf beside descendant attention as %s', (stage, tally) => {
    fixture.issues = [
      ...ISSUES,
      issue('sibling', 'Second delivery', { parentId: 'root', seq: 7, stage }),
    ]
    render(<SidebarUnified />)
    const status = missionRow().querySelector('[data-testid="row-lifecycle-status"]') as HTMLElement
    const phrase = status.querySelector<HTMLElement>('[data-testid="row-status-phrase"]')
    // The intermediate child is a container; only grandchild and sibling count.
    expect(phrase?.textContent).toBe('Waiting on you')
    expect(phrase?.style.color).toBe('var(--attention)')
    const fraction = screen.getByText(`· ${tally}`)
    expect(status.contains(fraction)).toBe(true)
    expect(fraction.classList.contains('text-text-faint')).toBe(true)
    expect(screen.queryByText('Second delivery')).toBeNull()
  })

  it('draws no agent stack on the row: the Flight Deck owns the fleet (POD-2074)', async () => {
    render(<SidebarUnified />)
    expect(missionRow().querySelector('[data-testid="issue-fleet-summary"]')).toBeNull()
  })

  it('moves closures to the Closed lane, and folds only folders', async () => {
    render(<SidebarUnified />)
    const closed = screen.getByTestId('work-lane-closed')
    expect(closed.textContent).toContain('1')
    expect(closed.getAttribute('aria-selected')).toBe('false')
    expect(screen.queryByText('Balanced desktop shell')).toBeNull()
    // WHAT MAY FOLD, EXHAUSTIVELY: the folder headers. No ROW has a disclosure
    // of its own — that is the tree this column refuses to grow.
    const foldables = screen
      .getAllByRole('button')
      .filter(
        (button) => button.hasAttribute('aria-expanded') && !button.hasAttribute('aria-haspopup'),
      )
    for (const button of foldables)
      expect(['project-group-label', 'pinned-section-label']).toContain(
        button.getAttribute('data-testid'),
      )
    await act(async () => {
      fireEvent.click(closed)
    })
    expect(screen.getByText('Balanced desktop shell')).toBeTruthy()
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
  it('shows no proposed work anywhere in the column', async () => {
    render(<SidebarUnified />)
    expect(screen.queryByTestId('proposed-fold-toggle')).toBeNull()
    expect(screen.queryByTestId('proposed-issue-fold')).toBeNull()
    expect(screen.queryByText('Review captures')).toBeNull()
    // Not hiding in the two folds that remain, either.
    await act(async () => {
      fireEvent.click(screen.getByTestId('work-lane-closed'))
    })
    expect(screen.queryByText('Review captures')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('work-lane-snoozed'))
    })
    expect(screen.queryByText('Review captures')).toBeNull()
  })

  // POD-540. The fold keys are per-user REPLICATED (that is what the
  // `podium:sidebar:` spelling buys, see fold-keys.ts), so the row arrives over
  // the wire after first render. `useCollapsed` used to seed itself from a
  // `useState` initializer, which read null, fell back to the default and never
  // ran again — so every fold in this column came back closed on reload however
  // you left it. Now that the group folds are the ONLY foldable things here,
  // that bug is the whole of the column's memory.
  it('restores a fold from replicated layout state that lands after mount', async () => {
    render(<SidebarUnified />)
    const toggle = () => screen.getByTestId('project-group-label')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')

    await act(async () => ui.hydrate(projectFoldKey('/repo'), 'true'))

    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('writes a fold through the store rather than holding it in local state', async () => {
    render(<SidebarUnified />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-group-label'))
    })
    // The press wrote; the value came back through the subscription. One source
    // of truth, so the rendered fold and the stored row cannot diverge.
    expect(ui.get(projectFoldKey('/repo'))).toBe('true')
    expect(screen.getByTestId('project-group-label').getAttribute('aria-expanded')).toBe('false')
  })
})
