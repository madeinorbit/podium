// @vitest-environment happy-dom
//
// BRING BACK (POD-1188) — the inverse of the Tuck chip, reached by right-clicking
// the folded row it produced. Two rows sit in this fold and they are folded for
// DIFFERENT reasons, which is the whole subject of these tests:
//
//  - POD-42 was tucked away a minute ago. The tuck is the only thing holding it
//    down, so clearing it returns the row to the live list — the item acts.
//  - POD-43 closed weeks ago and was never tucked. The finished-grace backstop
//    folds it whether anyone tucked it or not, so clearing a tuck it does not
//    have would move nothing — the item says so instead of lying.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// A live ui-state collection, as in the lifecycle suite: the tail folds are shut
// by default and SUBSCRIBE to their per-user row, so a `set` that stores nothing
// means the fold never opens and there is no folded row to right-click.
const ui = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    get: (key: string): string | null => rows.get(key) ?? null,
    set: (key: string, value: string | null): void => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
      for (const listener of listeners) listener()
    },
    subscribe: (callback: () => void): (() => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    reset: (): void => rows.clear(),
  }
})

const setIssueTucked = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/app/store', () => {
  const base = {
    repoPath: '/repo',
    prefix: 'POD',
    description: '',
    stage: 'done',
    closedReason: 'done',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    blockedByNotes: [],
    createdAt: '2026-07-20T00:00:00.000Z',
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
    ready: false,
    blocked: false,
    deferred: false,
    unread: false,
    readAt: '2026-07-23T11:00:00.000Z',
  }
  // Freshly finished against the real clock the sidebar reads, then tucked: the
  // grace window still holds, so placement is the tuck's doing alone.
  const tucked = {
    ...base,
    id: 'tucked',
    seq: 42,
    displayRef: 'POD-42',
    title: 'Tucked by mistake',
    closedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    tuckedAt: new Date(Date.now() - 30_000).toISOString(),
  }
  // Never tucked, and long past the grace window: the backstop owns this row.
  const aged = {
    ...base,
    id: 'aged',
    seq: 43,
    displayRef: 'POD-43',
    title: 'Old closure',
    closedAt: '2026-07-23T10:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z',
    tuckedAt: null,
  }
  // Suspended, not closed: it lives in the OTHER tail fold, and its inverse is
  // Unsnooze rather than a bring-back — so it must get no menu from this gate.
  const snoozed = {
    ...base,
    id: 'snoozed',
    seq: 44,
    displayRef: 'POD-44',
    title: 'Suspended work',
    stage: 'in_progress',
    closedReason: null,
    updatedAt: '2026-07-23T10:00:00.000Z',
    deferUntil: '2099-01-01T00:00:00.000Z',
    deferred: true,
    tuckedAt: null,
  }
  const useStore = () => ({
    uiState: ui,
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [tucked, aged, snoozed],
    trpc: {
      settings: { get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'codex' } })) } },
      issues: {
        archive: { mutate: vi.fn(async () => ({})) },
        defer: { mutate: vi.fn(async () => ({})) },
        update: { mutate: vi.fn(async () => ({})) },
      },
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
    markIssueRead: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}),
    updateIssue: vi.fn(async () => {}),
    archiveIssue: vi.fn(async () => {}),
    deleteIssue: vi.fn(async () => {}),
    setIssueTucked,
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
  })
  return {
    useStore,
    useReplicaIssues: () => useStore().issues,
    useStoreSelector: (selector: (state: unknown) => unknown) => selector(useStore() as never),
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

/** Open the Closed fold and hand back the folded row carrying `title`. */
function foldedRow(title: string): HTMLElement {
  fireEvent.click(screen.getByTestId('closed-fold-toggle'))
  const row = screen.getByText(title).closest('[data-testid=folded-work-row]')
  if (!(row instanceof HTMLElement)) throw new Error(`no folded row for "${title}"`)
  return row
}

afterEach(() => {
  cleanup()
  ui.reset()
  setIssueTucked.mockClear()
})

describe('bring a tucked row back out of the fold (POD-1188)', () => {
  it('offers Bring back on a tucked row and clears the tuck through the store action', () => {
    render(<SidebarUnified />)
    const row = foldedRow('Tucked by mistake')

    // A right-click must not also select the row: the menu is the gesture.
    fireEvent.contextMenu(row)
    expect(screen.getByRole('menu', { name: 'Folded task actions' })).toBeTruthy()
    // The panel names the row it acts on, like every other menu in this column.
    expect(screen.getByText('POD-42')).toBeTruthy()

    fireEvent.click(screen.getByTestId('bring-back'))

    // The same outboxed store action the Tuck chip uses, with the flag flipped —
    // NOT a second mechanism, and not a local set of ids (POD-333).
    expect(setIssueTucked).toHaveBeenCalledWith('tucked', false)
    // The menu is a one-shot: it closes on the press.
    expect(screen.queryByRole('menu', { name: 'Folded task actions' })).toBeNull()
  })

  it('states its case on a row the grace backstop holds down, and sends nothing', () => {
    render(<SidebarUnified />)

    fireEvent.contextMenu(foldedRow('Old closure'))

    // Offered and disabled with the reason, never silently absent (POD-821):
    // clearing a tuck this row never had would leave it exactly where it is.
    expect(screen.queryByTestId('bring-back')).toBeNull()
    const blocked = screen.getByTestId('bring-back-blocked')
    expect(blocked.textContent).toContain('The fold keeps closures older than a day')
    fireEvent.click(blocked)
    expect(setIssueTucked).not.toHaveBeenCalled()
  })

  it('does not open on a SUSPENDED row, whose inverse is Unsnooze', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('snoozed-fold-toggle'))
    const row = screen.getByText('Suspended work').closest('[data-testid=folded-work-row]')
    expect(row).toBeTruthy()
    expect((row as HTMLElement).getAttribute('data-lane')).toBe('snoozed')

    fireEvent.contextMenu(row as HTMLElement)

    // A snoozed row was never tucked, so the one item this panel carries would
    // have nothing to undo. It keeps the browser's own menu rather than an
    // app menu whose only entry is inert.
    expect(screen.queryByRole('menu', { name: 'Folded task actions' })).toBeNull()
  })
})
