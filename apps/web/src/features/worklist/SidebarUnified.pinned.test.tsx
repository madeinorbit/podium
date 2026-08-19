// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// A live ui-state collection (POD-540): the worklist's group folds SUBSCRIBE to
// their per-user replicated row rather than seeding local state, so a `set` that
// stores nothing means the fold never opens. Backed by a Map so a press writes
// and the value comes back through the subscription, as in the real store.
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

// One idle session per issue so each renders as a plain WORK row.
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

// 'pin' is pinned (and coloured); 'plain' is an ordinary group row.
vi.mock('@/app/store', () => {
  const useStore = () => ({
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [idleSess('s-pin', 'pin'), idleSess('s-plain', 'plain')],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      issue('pin', 'Pinned issue', { pinned: true, color: 'violet' }),
      issue('plain', 'Plain issue'),
      issue('closed-a', 'Closed alpha', {
        stage: 'done',
        closedReason: 'done',
        closedAt: '2026-06-10T00:00:00.000Z',
        readAt: '2026-06-11T00:00:00.000Z',
        unread: false,
      }),
      issue('closed-b', 'Closed beta', {
        stage: 'done',
        closedReason: 'done',
        closedAt: '2026-06-09T00:00:00.000Z',
        readAt: '2026-06-11T00:00:00.000Z',
        unread: false,
      }),
      issue('closed-unread', 'Closed result unseen', {
        stage: 'done',
        closedReason: 'done',
        closedAt: '2026-06-12T00:00:00.000Z',
        readAt: undefined,
        unread: true,
      }),
      issue('closed-selected', 'Closed result selected', {
        stage: 'done',
        closedReason: 'done',
        closedAt: '2026-06-08T00:00:00.000Z',
        readAt: '2026-06-11T00:00:00.000Z',
        unread: false,
      }),
    ],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: 'closed-selected',
    setSelectedIssueId: vi.fn(),
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    uiState: ui,
    spawnDraftAgent: vi.fn(),
    markIssueRead: vi.fn(),
    markSessionRead: vi.fn(),
  })
  return {
    useStore,
    useReplicaIssues: () => useStore().issues,
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

function rowButton(label: string): HTMLElement {
  const span = screen.getByText(label)
  const btn = span.closest('button')
  if (!btn) throw new Error(`no button for ${label}`)
  return btn
}

afterEach(() => {
  cleanup()
  ui.reset()
})

describe('SidebarUnified PINNED section (POD-166, R3)', () => {
  it('pinned issues MOVE into one PINNED section above all project groups', () => {
    render(<SidebarUnified />)
    const section = screen.getByTestId('pinned-section')
    // The pinned row lives inside the PINNED section…
    expect(section.contains(rowButton('Pinned issue'))).toBe(true)
    // …and has LEFT its project group (move, not copy).
    const group = screen.getByTestId('project-group')
    expect(group.contains(rowButton('Pinned issue'))).toBe(false)
    expect(group.contains(rowButton('Plain issue'))).toBe(true)
    // The section label reads PINNED and sits before the group in the DOM.
    const label = screen.getByTestId('pinned-section-label')
    expect(label.textContent).toContain('Pinned')
    expect(section.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps folded live rows as direct drag-scope children and starts the gesture', () => {
    render(<SidebarUnified />)
    const group = screen.getByTestId('project-group')
    const panel = screen.getByTestId('project-group-rows')
    const pinnedPanel = screen.getByTestId('pinned-section-rows')
    const row = rowButton('Plain issue').closest<HTMLElement>('[data-drag-key="plain"]')
    const grip = row?.querySelector<HTMLElement>('[data-testid="row-grip"]')
    if (!row || !grip) throw new Error('plain issue is missing its draggable row contract')

    // POD-1253 inserted FoldPanel between the scope and these rows. The drag
    // hook intentionally reads direct children so nested closed/snoozed rows do
    // not enter the live order; putting the scope on the panel preserves both.
    expect(panel.getAttribute('data-drag-scope')).toMatch(/^group:/)
    expect(row.parentElement).toBe(panel)
    expect(group.hasAttribute('data-drag-scope')).toBe(false)

    grip.setPointerCapture = vi.fn()
    grip.hasPointerCapture = () => false
    grip.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(grip, { button: 0, pointerId: 7, clientY: 10 })

    // Starting proves useRowDrag found the row in its scope. The animated clip
    // is relaxed only during the gesture, while the whole section is lifted so
    // a Pinned crossing remains visible above neighbouring Motion sections.
    expect(row.style.position).toBe('relative')
    expect(panel.style.overflow).toBe('visible')
    expect(panel.style.contain).toBe('none')
    expect(pinnedPanel.style.overflow).toBe('visible')
    expect(pinnedPanel.style.contain).toBe('none')
    expect(group.style.zIndex).toBe('40')

    fireEvent.pointerUp(window, { pointerId: 7, clientY: 10 })
    expect(row.style.position).toBe('')
    expect(panel.style.overflow).toBe('')
    expect(panel.style.contain).toBe('layout paint')
    expect(pinnedPanel.style.overflow).toBe('')
    expect(pinnedPanel.style.contain).toBe('layout paint')
    expect(group.style.zIndex).toBe('')
  })

  it('a coloured, unselected row is hover-tintable via the var-driven background (§7 fix)', () => {
    render(<SidebarUnified />)
    const row = rowButton('Pinned issue').closest('[class*="group/row"]') as HTMLElement
    // Backgrounds ride CSS vars so hover: can win over the resting tint —
    // an inline `background` would always beat the hover class.
    expect(row.className).toContain('bg-[var(--row-bg)]')
    expect(row.className).toContain('hover:bg-[var(--row-hover-bg)]')
    expect(row.getAttribute('style')).toContain('--row-hover-bg')
  })

  it('folds settled closures per project; selected open finished rows keep the full lane', async () => {
    render(<SidebarUnified />)

    // Unread no longer blocks fold eligibility (manual tuck path). Past-grace
    // finished rows — read or not — land in Closed; only selection stickiness
    // keeps a selected finished row open without an explicit tuck.
    const toggle = screen.getByRole('button', { name: '3 closed' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Closed alpha')).toBeNull()
    expect(screen.queryByText('Closed beta')).toBeNull()
    expect(screen.queryByText('Closed result unseen')).toBeNull()
    expect(screen.getByText('Closed result selected')).toBeTruthy()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Closed alpha')).toBeTruthy()
    expect(screen.getByText('Closed beta')).toBeTruthy()
    expect(screen.getByText('Closed result unseen')).toBeTruthy()
    expect(rowButton('Closed alpha').closest('[data-drag-key="closed-a"]')?.className).toContain(
      'opacity-50',
    )

    fireEvent.click(toggle)
    // A SHUT FOLD IS NOT AN INSTANT UNMOUNT ANY MORE (POD-1253). The disclosure
    // clips its own height away and the rows leave with it, so they are still in
    // the DOM for the length of that exit — `waitFor` is asserting the same
    // thing this always asserted, at the end of the gesture rather than in the
    // frame the click landed in.
    await waitFor(() => expect(screen.queryByText('Closed alpha')).toBeNull())
  })

  /**
   * THE BANDS FOLD (POD-1057, the 3a design).
   *
   * Every section header in this column is a control now — `Pinned` and one per
   * project — so a machine carrying four repos can be reduced to four lines with
   * one of them open. The three things worth pinning down: the band stays while
   * its contents go, a shut project takes its TAIL FOLDS with it (half a
   * collapsed project is the worst of both readings), and the state lands on the
   * per-user replicated `podium:sidebar:` key rather than somewhere device-local.
   */
  it('shuts the PINNED band without shutting the column', async () => {
    render(<SidebarUnified />)
    const band = screen.getByTestId('pinned-section-label')
    expect(band.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Pinned issue')).toBeTruthy()

    fireEvent.click(band)

    expect(band.getAttribute('aria-expanded')).toBe('false')
    expect(band.getAttribute('data-collapsed')).toBe('true')
    // The band itself survives — with its count, which is the whole point of
    // being able to shut it and still know what is in there.
    expect(band.textContent).toContain('Pinned')
    await waitFor(() => expect(screen.queryByText('Pinned issue')).toBeNull())
    // The project below is untouched.
    expect(screen.getByText('Plain issue')).toBeTruthy()
    expect(ui.get('podium:sidebar:pinned-fold')).toBe('true')

    fireEvent.click(band)
    expect(screen.getByText('Plain issue')).toBeTruthy()
    expect(screen.getByText('Pinned issue')).toBeTruthy()
    // Back to default = the key is CLEARED, not written 'false': an absent key
    // is what "expanded" means, and storing the default would replicate a row
    // per project per user saying nothing.
    expect(ui.get('podium:sidebar:pinned-fold')).toBeNull()
  })

  it('shuts a project band over its rows AND its closed fold', async () => {
    render(<SidebarUnified />)
    const group = screen.getByTestId('project-group')
    const groupKey = screen
      .getByTestId('project-group-rows')
      .getAttribute('data-drag-scope')
      ?.replace(/^group:/, '')
    const band = screen.getByTestId('project-group-label')
    expect(screen.getByTestId('closed-fold-toggle')).toBeTruthy()

    fireEvent.click(band)

    expect(group.getAttribute('data-collapsed')).toBe('true')
    await waitFor(() => {
      expect(screen.queryByText('Plain issue')).toBeNull()
      expect(screen.queryByTestId('closed-fold-toggle')).toBeNull()
    })
    // Pinned work lives above every project group, so it is not a project's to
    // hide (POD-166, R3) — and this is the assertion that proves the two bands
    // read independent state rather than sharing one key.
    expect(screen.getByText('Pinned issue')).toBeTruthy()
    expect(ui.get(`podium:sidebar:project-fold:${groupKey}`)).toBe('true')

    fireEvent.click(band)
    expect(screen.getByText('Plain issue')).toBeTruthy()
    expect(screen.getByTestId('closed-fold-toggle')).toBeTruthy()
  })
})
