import { act, cleanup, render, screen } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from '@/features/worklist/SidebarUnified'

const ISSUE_COUNT = 674
const NOW = Date.parse('2026-08-23T12:00:00.000Z')

function issueAt(index: number) {
  return {
    id: `issue-${index}`,
    repoPath: '/repo',
    seq: 10_000 + index,
    displayRef: `POD-${10_000 + index}`,
    title: index === ISSUE_COUNT - 1 ? 'Only responsive target' : `Generated task ${index}`,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    blockedByNotes: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
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
    readAt: '2026-08-20T00:00:00.000Z',
    unread: false,
  }
}

function sessionAt(index: number) {
  return {
    sessionId: `session-${index}`,
    agentKind: 'codex',
    cwd: '/repo',
    title: `Generated session ${index}`,
    status: 'live',
    controllerId: null,
    geometry: { cols: 120, rows: 36 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-20T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    issueId: `issue-${index}`,
    busy: false,
    readAt: '2026-08-20T00:00:00.000Z',
    unread: false,
    agentState: { phase: 'idle', idle: { kind: 'done' } },
  }
}

const largeState = vi.hoisted(() => ({ store: {} as Record<string, unknown> }))

vi.mock('@/app/store', () => {
  const useStore = () => largeState.store
  return {
    useStore,
    useReplicaIssues: () => largeState.store.issues ?? [],
    useStoreSelector: (selector: (store: Record<string, unknown>) => unknown) =>
      selector(largeState.store),
    useSlice: (definition: { derive: (store: Record<string, unknown>) => unknown }) =>
      definition.derive(largeState.store),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTMLInputElement.value setter is unavailable')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => cleanup())

describe('large-state responsive filtering', () => {
  it('commits the urgent work query before the deferred 674-row tree, then settles', async () => {
    const issues = Array.from({ length: ISSUE_COUNT }, (_, index) => issueAt(index))
    largeState.store = {
      coarseNow: NOW,
      repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
      sessions: Array.from({ length: ISSUE_COUNT }, (_, index) => sessionAt(index)),
      machines: [],
      pins: { panels: [], worktrees: [], repos: [] },
      issues,
      selectedWorktree: null,
      selectedIssueId: null,
      paneA: null,
      fileTabs: [],
      view: 'workspace',
      sidebarSettings: { groupByRepo: false },
      uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
      trpc: {
        settings: { get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'codex' } })) } },
        issues: { defer: { mutate: vi.fn(async () => ({})) } },
      },
      setPinned: vi.fn(),
      setSelectedWorktree: vi.fn(),
      setSelectedIssueId: vi.fn(),
      setOpenIssueId: vi.fn(),
      setPane: vi.fn(),
      setView: vi.fn(),
      setSidebarSettings: vi.fn(),
      spawnDraftAgent: vi.fn(),
      markIssueRead: vi.fn(),
      markSessionRead: vi.fn(),
    }

    render(<SidebarUnified />)
    const input = screen.getByTestId('work-search-input') as HTMLInputElement
    expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(ISSUE_COUNT)

    flushSync(() => setNativeInputValue(input, 'only responsive target'))

    // The controlled field has committed, while the deferred list still shows
    // its previous complete tree. No timer or elapsed-time threshold is involved.
    expect(input.value).toBe('only responsive target')
    expect(screen.getAllByTestId('unified-issue-row')).toHaveLength(ISSUE_COUNT)
    expect(screen.getByTestId('work-search-count').textContent).toBe('674/674')

    await act(async () => {})

    const settled = screen.getAllByTestId('unified-issue-row')
    expect(settled).toHaveLength(1)
    expect(settled[0]?.textContent).toContain('Only responsive target')
    expect(screen.getByTestId('work-search-count').textContent).toBe('1/674')
  }, 20_000)
})
