// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

// A single idle session so its issue renders as a plain WORK row (not lifted to
// WORKING, whose suppress-unread logic would muddy the weight assertions).
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
    readAt: '2026-06-20T00:00:00.000Z',
    unread: false,
    ...over,
  }
}

// Issue 'a' is SELECTED (active) + read; issue 'b' is unread + unselected.
vi.mock('./store', () => {
  const useStore = () => ({
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [idleSess('s-a', 'a'), idleSess('s-b', 'b')],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      issue('a', 'Read selected issue'),
      issue('b', 'Unread issue', { readAt: null, unread: true }),
    ],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: 'a',
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
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('./HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

// The clickable row button that carries the label text.
function rowButton(label: string): HTMLElement {
  const span = screen.getByText(label)
  const btn = span.closest('button')
  if (!btn) throw new Error(`no button for ${label}`)
  return btn
}

afterEach(cleanup)

describe('SidebarUnified selection weight (#170 Fix 1)', () => {
  it('a selected-but-read row is NOT bold — selection is background-only', () => {
    render(<SidebarUnified />)
    const active = rowButton('Read selected issue')
    // Selection reads as an accent background, not a heavier font.
    expect(active.className).toContain('bg-accent')
    expect(active.className).toContain('text-accent-foreground')
    // NEITHER weight class may appear on the selected read row.
    expect(active.className).not.toContain('font-medium')
    expect(active.className).not.toContain('font-semibold')
    // The label span itself is normal weight too.
    const label = screen.getByText('Read selected issue')
    expect(label.className).not.toContain('font-semibold')
    expect(label.className).not.toContain('font-medium')
  })

  it('unread remains the sole weight signal', () => {
    render(<SidebarUnified />)
    const unreadLabel = screen.getByText('Unread issue')
    expect(unreadLabel.className).toContain('font-medium')
  })
})
