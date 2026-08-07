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
 *   4. the only foldable things left are the Proposed and Closed group headers.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { proposedFoldKey } from './fold-keys'
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
      .map((row) => row.querySelector('.shell-type-primary')?.textContent)
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
    const pill = missionRow().querySelector('[data-testid="need-pill"]') as HTMLElement
    expect(pill.textContent).toBe('Needs you')
    expect(pill.getAttribute('aria-label')).toBe('1 waiting on you')
    // And the status line names WHERE, since no visible row can explain it.
    const status = missionRow().querySelector('[data-testid="row-lifecycle-status"]') as HTMLElement
    expect(status.textContent).toContain('deep: #3 needs you')
    // A mission with nothing asked of the human wears no pill at all.
    const solo = screen
      .getByText('Sidebar unread dot')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(solo.querySelector('[data-testid="need-pill"]')).toBeNull()
  })

  it('stacks real harness kinds with the live total and the native-child count', () => {
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
    expect(fleet.getAttribute('title')).toBe('5 live agents · 3 native children')
    // A lone agent shows its tile and no total — the number would say nothing.
    const solo = screen
      .getByText('Sidebar unread dot')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(solo.querySelector('[data-testid="issue-fleet-summary"]')).toBeNull()
  })

  it('ends the column with the two group folds and nothing else foldable', () => {
    render(<SidebarUnified />)
    const proposed = screen.getByTestId('proposed-fold-toggle')
    const closed = screen.getByTestId('closed-fold-toggle')
    expect(proposed.textContent).toContain('Proposed · 1')
    expect(closed.textContent).toContain('Closed · 1')
    // Both start folded, and Proposed comes first — the artifact's order.
    expect(proposed.getAttribute('aria-expanded')).toBe('false')
    expect(closed.getAttribute('aria-expanded')).toBe('false')
    expect(proposed.compareDocumentPosition(closed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // They are the ONLY disclosures in the column. (The ID square's colour
    // picker also carries aria-expanded, but it is a popup — `aria-haspopup`
    // separates "opens a menu" from "reveals the rows beneath me".)
    expect(
      screen
        .getAllByRole('button')
        .filter(
          (button) => button.hasAttribute('aria-expanded') && !button.hasAttribute('aria-haspopup'),
        ),
    ).toEqual([proposed, closed])
  })

  it('opens the proposed fold onto one dim line per untriaged issue', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('proposed-fold-toggle'))
    const rows = screen.getAllByTestId('proposed-fold-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Review captures')
    expect(rows[0]?.textContent).toContain('proposed')
    // A proposal is not live work: it never gets a full row's chrome.
    expect(rows[0]?.querySelector('[data-testid="unified-issue-row"]')).toBeNull()
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
    const toggle = () => screen.getByTestId('proposed-fold-toggle')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    act(() => ui.hydrate(proposedFoldKey('/repo'), 'false'))

    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('proposed-fold-row')).toHaveLength(1)
  })

  it('writes a fold through the store rather than holding it in local state', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('proposed-fold-toggle'))
    // The press wrote; the value came back through the subscription. One source
    // of truth, so the rendered fold and the stored row cannot diverge.
    expect(ui.get(proposedFoldKey('/repo'))).toBe('false')
    expect(screen.getByTestId('proposed-fold-toggle').getAttribute('aria-expanded')).toBe('true')
  })
})
