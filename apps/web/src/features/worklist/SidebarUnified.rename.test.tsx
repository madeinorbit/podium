// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const updateMutate = vi.fn(async () => ({}))

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
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  updateMutate.mockClear()
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

  it('Enter commits the new title via trpc.issues.update', () => {
    render(<SidebarUnified />)
    fireEvent.doubleClick(screen.getByText('Original title'))
    const input = screen.getByDisplayValue('Original title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed issue' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(updateMutate).toHaveBeenCalledWith({ id: 'a', patch: { title: 'Renamed issue' } })
  })

  it('Escape cancels without mutating', () => {
    render(<SidebarUnified />)
    fireEvent.doubleClick(screen.getByText('Original title'))
    const input = screen.getByDisplayValue('Original title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
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
    expect(updateMutate).not.toHaveBeenCalled()
  })
})
