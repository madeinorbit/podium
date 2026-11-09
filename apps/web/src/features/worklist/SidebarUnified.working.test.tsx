import '@/test-support/mock-pool-fixture'
import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
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
    ...over,
  }
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    // ui-state collection (persisted section collapse etc.) — absent key = default.
    uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
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
      { ...sess('s-draft', 'draft', 'working'), name: 'Push the commits' },
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
      // A draft vessel: no title of its own, no worktree, one agent inside it.
      issue('draft', 'Draft', { draft: true }),
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
    navigateWorkspace: vi.fn(() => true),
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
    readFixture: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
// PanelRow (the lifted working session) pulls in the session guard, which needs a
// ConfirmProvider — stub it so the row renders without the provider tree.
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
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
    // Repo name, then the group's size pushed to the right edge (POD-725).
    expect(groups[0]?.textContent?.startsWith('repo')).toBe(true)
    expect(groups[0]?.querySelector('[data-testid="project-group-count"]')?.textContent).toBe('8')
    // Both issues render exactly once, inside the group.
    expect(screen.getAllByText('Fully working issue')).toHaveLength(1)
    expect(screen.getAllByText('Partly working issue')).toHaveLength(1)
    expect(screen.getAllByText('Reviewable issue')).toHaveLength(1)
  })

  // POD-1057 (3a): the lifecycle stamp lives in line 1's fixed meta column, not
  // trailing the status word on line 2. The words and the clock are separate
  // readings — one is prose, the other tabulates down the whole column — and
  // splitting them is what lets every row's title ellipsize at the same x.
  it('puts the working spinner + clock in the meta column, the word on line 2', () => {
    render(<SidebarUnified />)
    const workingRow = screen
      .getByText('Fully working issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(workingRow.querySelector('[data-phase="working"]')).toBeTruthy()
    const meta = workingRow.querySelector('[data-testid="row-meta-column"]') as HTMLElement
    // The clock is in the meta column; the working mark is line 2's status
    // mark, beside the word (POD-2074).
    expect(meta.querySelector('.pod-mark')).toBeNull()
    expect(meta.textContent).toMatch(/\d+:\d\d/)
    const workingStatus = workingRow.querySelector('[data-testid="row-lifecycle-status"]')
    expect(workingStatus?.querySelector('.pod-mark')).toBeTruthy()
    expect(workingStatus?.textContent).toContain('Working')
    // The partially-working issue has a question waiting → the row reads
    // waiting (stillness), and says so in line 2's one ochre sentence.
    const waitingRow = screen
      .getByText('Partly working issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(waitingRow.querySelector('[data-phase="waiting"]')).toBeTruthy()
    const waitingStatus = waitingRow.querySelector(
      '[data-testid="row-lifecycle-status"]',
    ) as HTMLElement
    expect(waitingStatus.getAttribute('data-phase')).toBe('waiting')
    expect(
      waitingStatus.querySelector<HTMLElement>('[data-testid="row-status-phrase"]')?.style.color,
    ).toBe('var(--attention)')
    // ONE ask, so no count leads the sentence — the pill's words earn their
    // place only for a branch whose ask is bigger than this row (POD-1057).
    expect(waitingRow.querySelector('[data-testid="need-count"]')).toBeNull()
  })

  // POD-703: the ask owns the phase, but the row is the only place this mission
  // appears — so an agent still computing under it must be visible, in the
  // motion grammar's own device. A mission with a live agent used to render as
  // total stillness the moment anything on it asked, which reads as "the fleet
  // stopped".
  it('keeps the working spinner on a waiting row that still has an agent computing', () => {
    render(<SidebarUnified />)
    const waitingRow = screen
      .getByText('Partly working issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    // Amber keeps line 2 (The Signal Rule): the meta column shows how long the
    // ask has been sitting there, not a second running clock …
    const meta = waitingRow.querySelector('[data-testid="row-meta-column"]') as HTMLElement
    expect(meta.querySelector('.pod-mark')).toBeNull()
    // … and the spinner sits in line 2's status lockup, where it is the row's
    // only "an agent is computing" mark rather than a second one.
    expect(waitingRow.querySelector('.pod-mark')).toBeTruthy()
    const status = waitingRow.querySelector('[data-testid="row-lifecycle-status"]')
    // The spinner carries live agent activity; the words say the ask.
    expect(status?.textContent).toContain('Waiting on you')
    expect(status?.textContent).not.toContain('agents')
    // A waiting row with nothing running stays perfectly still.
    const merge = screen
      .getByText('Reviewable issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(merge.querySelector('[data-phase="waiting"]')).toBeTruthy()
    expect(merge.querySelector('.pod-mark')).toBeNull()
  })

  // POD-516 §1.1: no roster band and no disclosure in this column. The calm
  // row (POD-2074) draws no agent stack either — the Flight Deck owns the fleet.
  it('shows no agent roster, stack or disclosure on a row', () => {
    render(<SidebarUnified />)
    const waitingRow = screen
      .getByText('Partly working issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(waitingRow.querySelector('[data-testid="issue-fleet-summary"]')).toBeNull()
    expect(waitingRow.querySelector('[data-testid="agent-roster-band"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand Partly working issue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse Partly working issue' })).toBeNull()
  })

  it('makes completion explicit and keeps clean git silent', () => {
    render(<SidebarUnified />)
    const doneRow = screen
      .getByText('Finished issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    const status = doneRow.querySelector('[data-testid="row-lifecycle-status"]') as HTMLElement
    expect(status.getAttribute('data-phase')).toBe('done')
    // Done is a check and a word, muted, and the row stays in Open until it
    // is tucked (POD-2074, design 7b).
    expect(status.textContent).toContain('Done')
    expect(status.querySelector('[data-testid="row-status-check"]')).toBeTruthy()
    expect(doneRow.querySelector('[data-testid="git-stamp"]')).toBeNull()
  })

  // POD-516 §1.1: a child issue has no row here at all. Its work reaches the
  // operator through the mission row's summary — the fleet stack counts its
  // sessions — and the tree itself lives in the Flight Deck.
  it('renders a parent as one flat row, with no child rows and no tree well', () => {
    render(<SidebarUnified />)
    expect(screen.queryByTestId('started-by-children')).toBeNull()
    expect(screen.queryByText('Nested child')).toBeNull()
    const parentRow = screen
      .getByText('Nested parent')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(parentRow.querySelector('[data-testid="agent-roster-band"]')).toBeNull()
  })

  it('shows unmerged done work as a tint-only branch attention chip', () => {
    render(<SidebarUnified />)
    const row = screen
      .getByText('Reviewable issue')
      .closest('[data-testid="unified-issue-row"]') as HTMLElement
    expect(row.querySelector('[data-phase="waiting"]')).toBeTruthy()
    // POD-293 / POD-1057: a decision row states its ask in words, and those
    // words are the row's whole amber voice — there is no pill and no square
    // dot beside them saying the same thing in a second vocabulary.
    expect(row.querySelector('[aria-label="1 waiting on you"]')).toBeNull()
    expect(row.querySelector('[data-testid="need-count"]')).toBeNull()
    const chip = row.querySelector('[data-testid="awaiting-merge-status"]') as HTMLElement
    expect(chip.textContent).toBe('Ready to merge')
    const status = row.querySelector('[data-testid="row-lifecycle-status"]') as HTMLElement
    expect(status.textContent).not.toMatch(/commit|·\s*\d/)
    // POD-293: the ask is the row's one bronze voice as a plain weighted word —
    // no boxed chip, no icon (the boxed pill made every review row shout).
    const phrase = row.querySelector('[data-testid="row-status-phrase"]') as HTMLElement
    expect(phrase.style.color).toBe('var(--attention)')
    expect(phrase.className).toContain('font-semibold')
    expect(chip.querySelector('svg')).toBeNull()
    // Git counters stay out of the sidebar.
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
    expect(mergeChip.textContent).toBe('Ready to merge')
    expect(merge.querySelector('[data-testid="row-lifecycle-status"]')?.textContent).not.toMatch(
      /commit|·\s*\d/,
    )

    const review = rowFor('Review without branch')
    expect(review.querySelector('[data-phase="waiting"]')).toBeTruthy()
    const reviewChip = review.querySelector('[data-decision="review"]') as HTMLElement
    expect(reviewChip.textContent).toBe('Needs review')
  })
})
