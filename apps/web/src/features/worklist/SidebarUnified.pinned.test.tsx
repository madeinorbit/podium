// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
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

  it('a coloured, unselected row is hover-tintable via the var-driven background (§7 fix)', () => {
    render(<SidebarUnified />)
    const row = rowButton('Pinned issue').closest('[class*="group/row"]') as HTMLElement
    // Backgrounds ride CSS vars so hover: can win over the resting tint —
    // an inline `background` would always beat the hover class.
    expect(row.className).toContain('bg-[var(--row-bg)]')
    expect(row.className).toContain('hover:bg-[var(--row-hover-bg)]')
    expect(row.getAttribute('style')).toContain('--row-hover-bg')
  })

  it('folds settled closures per project; selected open finished rows keep the full lane', () => {
    render(<SidebarUnified />)

    // Unread no longer blocks fold eligibility (manual tuck path). Past-grace
    // finished rows — read or not — land in Closed; only selection stickiness
    // keeps a selected finished row open without an explicit tuck.
    const toggle = screen.getByRole('button', { name: 'Closed · 3' })
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
    expect(screen.queryByText('Closed alpha')).toBeNull()
  })
})
