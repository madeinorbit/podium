// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// A minimal session shaped like the wire; `phase` drives the row's motion phase.
function sess(id: string, issueId: string, phase: 'working' | 'idle' | 'question') {
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
    agentState:
      phase === 'working'
        ? { phase: 'working', since: '2026-07-06T12:00:00.000Z' }
        : phase === 'question'
          ? { phase: 'idle', idle: { kind: 'question' }, since: '2026-07-06T12:00:00.000Z' }
          : { phase: 'idle', idle: { kind: 'done' } },
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
    ...over,
  }
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    // ui-state collection (persisted section collapse etc.) — absent key = default.
    uiState: { get: () => null, set: vi.fn() },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [
      sess('s-work', 'fully', 'working'), // fully-working issue → spinner row
      sess('s-run', 'partial', 'working'), // partial: working…
      sess('s-ask', 'partial', 'question'), // …but a question waits → amber row
      sess('s-merge', 'merge', 'idle'),
      {
        ...sess('s-finished', 'finished', 'idle'),
        agentState: { phase: 'idle', idle: { kind: 'done' }, workingMsTotal: 340_000 },
      },
      sess('s-parent', 'parent', 'idle'),
      sess('s-child', 'child', 'idle'),
    ],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      issue('fully', 'Fully working issue'),
      issue('partial', 'Partly working issue'),
      issue('merge', 'Reviewable issue', {
        stage: 'done',
        branch: 'issue/9-reviewable',
        closedAt: '2026-07-06T12:00:00.000Z',
        gitState: {
          updatedAt: '2026-07-06T12:00:00.000Z',
          branch: 'issue/9-reviewable',
          shared: false,
          ahead: 2,
          dirtyFiles: 0,
        },
      }),
      issue('finished', 'Finished issue', {
        stage: 'done',
        // Recent relative to the render's real clock (the sidebar reads live
        // `now`): a hard-coded past date would age out of the finished-visibility
        // window and silently drop the row, rotting the test over wall time.
        closedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        unread: true,
        gitState: {
          updatedAt: '2026-07-06T12:00:00.000Z',
          branch: 'main',
          shared: true,
          dirtyFiles: 0,
        },
      }),
      // POD-279: two review-stage issues whose agents already went quiet (no
      // live session, no surviving offer) — one with a branch to land, one
      // with only an artifact to look at.
      issue('review-merge', 'Review with branch', {
        stage: 'review',
        branch: 'issue/11-review-merge',
        gitState: {
          updatedAt: '2026-07-06T12:00:00.000Z',
          branch: 'issue/11-review-merge',
          shared: false,
          ahead: 1,
          dirtyFiles: 0,
        },
      }),
      issue('review-only', 'Review without branch', { stage: 'review' }),
      issue('parent', 'Nested parent', { childCount: 1, color: 'pink' }),
      issue('child', 'Nested child', { parentId: 'parent', audience: 'agent' }),
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
  })
  // The selector-store hook (refactor) reads slices off the same store shape.
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    // POD-331: the worklist is a PUBLISHED slice now, so the component reads it
    // through `useSlice` instead of deriving it locally. These suites assert
    // BEHAVIOUR, not derivation counts, so this derives on every read rather
    // than memoizing — sharing is measured in src/perf/slice-render-count.test.tsx,
    // and a mock that pretended to memoize here would be a second, untested
    // implementation of the mechanism.
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
// PanelRow (the lifted working session) pulls in the session guard, which needs a
// ConfirmProvider — stub it so the row renders without the provider tree.
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(cleanup)

describe('SidebarUnified per-row working grammar (#41)', () => {
  it('replaces the WORKING section with project groups carrying per-row state', () => {
    render(<SidebarUnified />)
    // No WORKING/WORK section headers — one project group holds every row.
    expect(screen.queryByText('WORKING')).toBeNull()
    expect(screen.queryByText('WORK')).toBeNull()
    const groups = screen.getAllByTestId('project-group-label')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.textContent).toBe('repo')
    // Both issues render exactly once, inside the group.
    expect(screen.getAllByText('Fully working issue')).toHaveLength(1)
    expect(screen.getAllByText('Partly working issue')).toHaveLength(1)
    expect(screen.getAllByText('Reviewable issue')).toHaveLength(1)
  })

  it('working rows show the braille spinner + timer; waiting rows the amber pill', () => {
    render(<SidebarUnified />)
    const workingRow = screen
      .getByText('Fully working issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    // The fully-working issue wears the working phase: spinner + counting timer.
    expect(workingRow.querySelector('[data-phase="working"]')).toBeTruthy()
    expect(workingRow.querySelector('.spb')).toBeTruthy()
    const workingStatus = workingRow.querySelector('[data-testid="row-lifecycle-status"]')
    expect(workingStatus?.textContent).toContain('working')
    expect(workingStatus?.textContent).toContain('·')
    // The partially-working issue has a question waiting → the row reads
    // waiting (stillness) with the amber count pill, working elsewhere or not.
    const waitingRow = screen
      .getByText('Partly working issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(waitingRow.querySelector('[data-phase="waiting"]')).toBeTruthy()
    expect(waitingRow.querySelector('[aria-label="1 waiting on you"]')).toBeTruthy()
  })

  it('shows agents as a count by default, folding the roster behind the chevron (POD-293)', () => {
    render(<SidebarUnified />)
    const waitingRow = screen
      .getByText('Partly working issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    // A non-pinned issue folds its roster by default: the fleet glyph carries
    // the count, and the AGENTS box is not spent until you ask for it.
    const fleet = waitingRow.querySelector('[data-testid="issue-fleet-summary"]') as HTMLElement
    expect(fleet).toBeTruthy()
    expect(fleet.querySelector('.rounded-full')).toBeNull()
    expect(waitingRow.querySelector('[data-testid="agent-roster-band"]')).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Expand Partly working issue' })
        .getAttribute('aria-expanded'),
    ).toBe('false')

    const expand = screen.getByRole('button', { name: 'Expand Partly working issue' })
    fireEvent.click(expand)

    expect(waitingRow.querySelector('[data-testid="agent-roster-band"]')).toBeTruthy()
    expect(waitingRow.querySelector('[data-testid="issue-fleet-summary"]')).toBeTruthy()
  })

  it('makes completion explicit and keeps clean git silent', () => {
    render(<SidebarUnified />)
    const doneRow = screen
      .getByText('Finished issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    const status = doneRow.querySelector('[data-testid="row-lifecycle-status"]') as HTMLElement
    expect(status.getAttribute('data-phase')).toBe('done')
    expect(status.textContent).toContain('done')
    expect(status.textContent).toContain('5:40 total')
    // Completion is stated in words now (POD-293): the done ✓ glyph is gone from
    // line 2 — "done · 5:40 total" in mono carries it, one clean voice, no icon.
    expect(status.querySelector('svg')).toBeNull()
    expect(doneRow.querySelector('[data-testid="git-stamp"]')).toBeNull()
  })

  it('makes nested issues direct children of one tinted connector rail', () => {
    render(<SidebarUnified />)
    const tree = screen.getByTestId('started-by-children')
    const child = tree.querySelector(':scope > [data-drag-key="child"]')

    expect(tree.getAttribute('data-drag-scope')).toBe('children:parent')
    expect(tree.style.getPropertyValue('--tree-guide')).toContain('#ec4899')
    expect(child).toBeTruthy()
    expect(child?.querySelector('[data-testid="unified-issue-row-started-by"]')).toBeTruthy()
  })

  it('fuses a lone driver into the row of a parent with subtasks (POD-267)', () => {
    render(<SidebarUnified />)
    const parentRow = screen
      .getByText('Nested parent')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    // Expanded (default): the subtask tree is open, and the single driving agent
    // is present as the row's fleet glyph — no AGENTS box of its own.
    expect(parentRow.querySelector('[data-testid="started-by-children"]')).toBeTruthy()
    expect(parentRow.querySelector('[data-testid="agent-roster-band"]')).toBeNull()
    expect(parentRow.querySelector('[data-testid="issue-fleet-summary"]')).toBeTruthy()
  })

  it('shows unmerged done work as a tint-only branch attention chip', () => {
    render(<SidebarUnified />)
    const row = screen
      .getByText('Reviewable issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(row.querySelector('[data-phase="waiting"]')).toBeTruthy()
    // POD-293: a decision row states its ask in words, so the amber count pill is
    // suppressed — the square's amber dot still marks the row as waiting.
    expect(row.querySelector('[aria-label="1 waiting on you"]')).toBeNull()
    expect(row.querySelector('[data-testid="issue-id-square"][data-badge="dot"]')).toBeTruthy()
    const chip = row.querySelector('[data-testid="awaiting-merge-status"]') as HTMLElement
    expect(chip.textContent).toBe('ready to merge · 2')
    // POD-293: the ask is the row's one amber voice as a plain weighted word —
    // no boxed chip, no icon (the boxed pill made every review row shout).
    expect(chip.className).toContain('text-attention')
    expect(chip.className).toContain('font-semibold')
    expect(chip.querySelector('svg')).toBeNull()
    // The word absorbs the merge axis: the git stamp must not repeat
    // "2 commits ahead" in a second amber counter (POD-279).
    expect(row.querySelector('[data-testid="git-stamp"]')).toBeNull()
  })

  // POD-279: a review queue is the commonest thing in this sidebar, and it was
  // reading as an undifferentiated "needs you" (or, once the offer was eaten,
  // as nothing at all). The row now names the decision it is actually asking for.
  it('names the pending decision on review-stage rows, offer or no offer', () => {
    render(<SidebarUnified />)
    const rowFor = (title: string) =>
      screen.getByText(title).closest('[data-testid="unified-issue-row"]') as HTMLElement

    const merge = rowFor('Review with branch')
    expect(merge.querySelector('[data-phase="waiting"]')).toBeTruthy()
    // The decision word is the row's one amber voice (POD-293) — no count pill.
    expect(merge.querySelector('[aria-label="1 waiting on you"]')).toBeNull()
    const mergeChip = merge.querySelector('[data-decision="merge"]') as HTMLElement
    expect(mergeChip.textContent).toBe('ready to merge · 1')

    const review = rowFor('Review without branch')
    expect(review.querySelector('[data-phase="waiting"]')).toBeTruthy()
    const reviewChip = review.querySelector('[data-decision="review"]') as HTMLElement
    expect(reviewChip.textContent).toBe('needs review')
  })
})
