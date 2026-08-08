// @vitest-environment happy-dom
/**
 * EVICT: A ROW LEAVES WITHOUT A DELETION (POD-407, readiness §3.1 item 2 /
 * POD-1077).
 *
 * Unsharing an issue removes it from this principal's slice WITHOUT its revision
 * moving and without a `remove` op — ADR 2 refuses to reuse `remove` precisely
 * because a replica would render it as a deletion. So the sidebar's whole job
 * here is to be quiet about it:
 *
 *   - the row goes, with no toast, tombstone or other deletion affordance;
 *   - the selection moves on if it was the selected row;
 *   - nothing re-requests the id (the heal loop ADR 2 names, which doubles as an
 *     existence oracle).
 *
 * The negative controls matter as much as the positive case. A finished issue
 * decaying out of the live list, and a client that has not yet received its first
 * issue payload, both look like "absent" from the worklist and neither is an
 * eviction — clearing the selection for either would be a bug that a
 * happy-path-only test would happily certify.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

const { setSelectedIssueId, issueGet } = vi.hoisted(() => ({
  setSelectedIssueId: vi.fn(),
  issueGet: vi.fn(async () => ({})),
}))

/** Mutable across renders so a test can take the issue away mid-flight. */
let currentIssues: unknown[] = []
let currentSelected: string | null = null

/** Same shape the sibling worklist suites use — a row only materialises when the
 *  issue carries the full nav model, so this is copied rather than minimised. */
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

const SHARED = issue('iss_shared', 'Shared with me')

vi.mock('@/app/store', () => {
  const useStore = () => ({
    uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: currentIssues,
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { get: { query: issueGet }, defer: { mutate: vi.fn(async () => ({})) } },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: currentSelected,
    setSelectedIssueId,
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
    setIssueTucked: vi.fn(async () => {}),
  })
  return {
    useStore,
    useReplicaIssues: () => currentIssues,
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
  setSelectedIssueId.mockClear()
  issueGet.mockClear()
  currentIssues = []
  currentSelected = null
})

describe('an evicted issue leaves the sidebar without a deletion', () => {
  it('drops the row and moves the selection on', async () => {
    currentIssues = [SHARED]
    currentSelected = SHARED.id
    const { rerender } = render(<SidebarUnified />)
    expect(await screen.findByText('Shared with me')).toBeTruthy()

    // Unshared: it is simply not in this principal's slice any more.
    currentIssues = []
    rerender(<SidebarUnified />)

    await waitFor(() => expect(setSelectedIssueId).toHaveBeenCalledWith(null))

    // The row leaves through the SAME transition every departing row uses
    // (`useRowTransitions` retains it for its exit, then drops it). That is
    // deliberately not asserted as instant removal here: the exit is the generic
    // row-leave motion, owned and tested by the transition machinery, and an
    // evicted row must look exactly like any other row leaving — that sameness
    // IS the requirement. What must not exist is anything that says DELETED,
    // which the sibling test below asserts.
    expect(screen.queryByRole('button', { name: /undo|restore|deleted/i })).toBeNull()
  })

  it('shows no deletion affordance and never re-requests the id', async () => {
    currentIssues = [SHARED]
    currentSelected = SHARED.id
    const { rerender } = render(<SidebarUnified />)
    await screen.findByText('Shared with me')

    currentIssues = []
    rerender(<SidebarUnified />)
    await waitFor(() => expect(setSelectedIssueId).toHaveBeenCalledWith(null))

    // No tombstone, no "deleted"/"removed" copy anywhere in the tree.
    expect(screen.queryByText(/deleted|removed|no longer exists/i)).toBeNull()
    // No heal loop: an invisible referent is never fetched again. That request
    // would also be an existence oracle (§3.1.2).
    expect(issueGet).not.toHaveBeenCalled()
  })

  // --- negative controls: absence that is NOT eviction ------------------------

  it('keeps the selection while the issue list is still empty on a cold client', async () => {
    // A reload restores selectedIssueId from the route before the first issue
    // payload lands. Clearing here would wipe the selection on every reload.
    currentIssues = []
    currentSelected = SHARED.id
    render(<SidebarUnified />)

    await waitFor(() => expect(screen.getByTestId('work-scroll')).toBeTruthy())
    expect(setSelectedIssueId).not.toHaveBeenCalledWith(null)
  })

  it('keeps the selection for an issue that is present but not rendered as a live row', async () => {
    // Tucked/decayed rows leave the live list while still existing in the slice.
    // Absence from the WORKLIST is not the eviction test; absence from the
    // replica's issues is.
    currentIssues = [
      issue('iss_shared', 'Shared with me', {
        tuckedAt: '2026-08-01T12:00:00.000Z',
        stage: 'done',
        closedReason: 'completed',
      }),
    ]
    currentSelected = SHARED.id
    render(<SidebarUnified />)

    await waitFor(() => expect(screen.getByTestId('work-scroll')).toBeTruthy())
    expect(setSelectedIssueId).not.toHaveBeenCalledWith(null)
  })
})
