// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

function idleSess(id: string, issueId: string) {
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
    readAt: '2026-07-06T12:00:00.000Z',
    unread: false,
    agentState: { phase: 'idle', idle: { kind: 'done' } },
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
    readAt: '2026-06-20T00:00:00.000Z',
    unread: false,
    ...over,
  }
}

/** `trpc.issues.update` — kept ONLY so the assertions below can prove nothing
 *  reaches it any more. The rename and the ID-square colour are both outboxed
 *  (POD-781): they call `store.updateIssue`. */
const updateMutate = vi.fn(async () => ({}))
const updateIssue = vi.fn(async () => {})

vi.mock('@/app/store', () => {
  const useStore = () => ({
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [idleSess('s-a', 'a')],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [issue('a', 'Original title')],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) }, update: { mutate: updateMutate } },
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
    uiState: { get: () => null, set: () => {}, subscribe: () => () => {} },
    spawnDraftAgent: vi.fn(),
    markIssueRead: vi.fn(),
    markSessionRead: vi.fn(),
    updateIssue,
    archiveIssue: vi.fn(async () => {}),
    deleteIssue: vi.fn(async () => {}),
    setIssueTucked: vi.fn(async () => {}),
  })
  // The selector-store hook reads slices off the same store shape.
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
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))
// Since POD-1077 the ISSUE menu confirms cascades through the same app-wide
// dialog, so it too wants a provider this focused tree does not mount.
vi.mock('@/lib/hooks/use-confirm', () => ({ useConfirm: () => vi.fn(async () => true) }))

afterEach(() => {
  cleanup()
  updateMutate.mockClear()
  updateIssue.mockClear()
})

describe('SidebarUnified issue rename (#170 Fix 3)', () => {
  it('double-click opens an inline editor seeded + selected with the title', () => {
    render(<SidebarUnified />)
    const label = screen.getByText('Original title')
    fireEvent.doubleClick(label)
    const input = screen.getByDisplayValue('Original title') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    // Focus + select-all on open (mirrors the session rename UX).
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Original title'.length)
  })

  // POD-781: the commit goes through the OUTBOX, so the row repaints on Enter
  // rather than after the round trip. Asserted against the store action and NOT
  // against `trpc.issues.update` — going back to the direct call would restore
  // the wait this issue removed, and a test that accepted either would not say so.
  it('Enter commits the new title through the outboxed updateIssue action', () => {
    render(<SidebarUnified />)
    fireEvent.doubleClick(screen.getByText('Original title'))
    const input = screen.getByDisplayValue('Original title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed issue' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(updateIssue).toHaveBeenCalledWith('a', { title: 'Renamed issue' })
    expect(updateMutate).not.toHaveBeenCalled()
  })

  it('Escape cancels without mutating', () => {
    render(<SidebarUnified />)
    fireEvent.doubleClick(screen.getByText('Original title'))
    const input = screen.getByDisplayValue('Original title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(updateIssue).not.toHaveBeenCalled()
    expect(updateMutate).not.toHaveBeenCalled()
    // Editor closed; the label is back.
    expect(screen.getByText('Original title')).toBeTruthy()
  })

  it('an empty/whitespace title is a no-op (no mutation)', () => {
    render(<SidebarUnified />)
    fireEvent.doubleClick(screen.getByText('Original title'))
    const input = screen.getByDisplayValue('Original title') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(updateIssue).not.toHaveBeenCalled()
    expect(updateMutate).not.toHaveBeenCalled()
  })

  // The colour picker used to hang off the row's ID square. The 3a design took
  // the square out of this column (POD-1057) and the affordance went where every
  // other property of an issue is set — the row's context menu. The WRITE is
  // what this test has always been about, and it is unchanged: outboxed through
  // `store.updateIssue`, never straight at `trpc.issues.update`.
  it('writes a picked colour through the outboxed updateIssue action', async () => {
    render(<SidebarUnified />)
    fireEvent.contextMenu(screen.getByText('Original title'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Set colour/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Violet' }))

    // The row repaints on the press (POD-781 group 2): the colour is one more
    // `issues.update` patch, so it rides the queue the rename already does.
    await waitFor(() => expect(updateIssue).toHaveBeenCalledWith('a', { color: 'violet' }))
    expect(updateMutate).not.toHaveBeenCalled()
  })
})
