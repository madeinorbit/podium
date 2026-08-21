// @vitest-environment happy-dom
/**
 * THE COLUMN'S HEAD, ITS UTILITIES, AND THE PROJECTS WITH NOTHING IN THEM
 * (POD-1469).
 *
 * Three things changed at once, and they are one change:
 *
 *   1. `New <Agent> in <Repo>` — a chip that spawned a harness on click, with a
 *      chevron inside its outline holding the agent → repo → machine menu — is
 *      one `New task` button that makes NO choices. It clears the selection,
 *      which is the state the shell already reads as "no mission on screen", and
 *      the cold-start composer asks for the work before any harness exists. That
 *      is the assertion with teeth: a click here must spawn NOTHING.
 *
 *   2. `Add project` came up from a 35px footer that also held a search glyph
 *      duplicating a globally-bound ⌘K and a hint advertising the same chord a
 *      second time. The footer is gone; the button is on the filter's line, in
 *      words.
 *
 *   3. A repo with no work at all used to vanish from the column entirely,
 *      because groups are built out of ROWS — so adding a project appeared to do
 *      nothing. Empty projects keep their band, with one quiet door under it.
 */

import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

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

const spawnDraftAgent = vi.hoisted(() => vi.fn())
const setSelectedIssueId = vi.hoisted(() => vi.fn())
const setSelectedWorktree = vi.hoisted(() => vi.fn())
const setView = vi.hoisted(() => vi.fn())

function issue(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    repoPath: '/work/podium',
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

vi.mock('@/app/store', () => {
  const useStore = () => ({
    uiState: ui,
    // Two projects, and only one of them has ever been worked.
    repos: [
      { path: '/work/podium', kind: 'repository', branch: 'main', worktrees: [] },
      { path: '/work/spare', kind: 'repository', branch: 'main', worktrees: [] },
    ],
    sessions: [],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [issue('a', 'Alpha')],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
    },
    spawnDraftAgent,
    selectedWorktree: null,
    setSelectedWorktree,
    selectedIssueId: null,
    setSelectedIssueId,
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView,
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    markIssueRead: vi.fn(),
    markSessionRead: vi.fn(),
  })
  return {
    useStore,
    useReplicaIssues: () => useStore().issues,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  ui.reset()
  spawnDraftAgent.mockClear()
  setSelectedIssueId.mockClear()
  setSelectedWorktree.mockClear()
  setView.mockClear()
})

function draft(): Record<string, unknown> {
  return JSON.parse(ui.get(FIRST_TASK_ACTIVATION_DRAFT_KEY) ?? '{}') as Record<string, unknown>
}

describe('the head is one button that makes no choices', () => {
  it('names the task, not a harness and a repo', () => {
    render(<SidebarUnified />)
    const button = screen.getByTestId('new-task-button')
    expect(button.textContent).toContain('New task')
    expect(button.textContent).not.toMatch(/Claude|podium/)
    // The chevron that opened the agent → repo → machine menu went with it.
    expect(screen.queryByRole('button', { name: 'Choose agent and repo' })).toBeNull()
  })

  it('opens a blank mission and spawns nothing', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('new-task-button'))

    expect(setSelectedIssueId).toHaveBeenCalledWith(null)
    expect(setSelectedWorktree).toHaveBeenCalledWith(null)
    expect(setView).toHaveBeenCalledWith('workspace')
    expect(spawnDraftAgent).not.toHaveBeenCalled()
  })

  it('clears a half-written prompt without forgetting the instruments', () => {
    ui.set(
      FIRST_TASK_ACTIVATION_DRAFT_KEY,
      JSON.stringify({
        repoPath: '/work/podium',
        machineId: 'machine-a',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        title: 'Half a thought',
        pendingIssueId: 'issue-abandoned',
      }),
    )
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('new-task-button'))

    // The prompt and the retry ids belong to a create that is now abandoned.
    expect(draft().title).toBe('')
    expect(draft().pendingIssueId).toBe('')
    // The agent, model, effort and host are settings, not content.
    expect(draft().agent).toBe('codex')
    expect(draft().model).toBe('gpt-5.6-sol')
    expect(draft().effort).toBe('high')
    expect(draft().machineId).toBe('machine-a')
  })
})

describe('the utilities came up out of the footer', () => {
  it('puts Add repository on the filter line and leaves no strip at the foot', () => {
    const view = render(<SidebarUnified />)
    const add = screen.getByTestId('add-repository')
    // Same row as the field it rides beside.
    expect(add.parentElement?.querySelector('[data-testid="work-search"]')).toBeTruthy()
    // The words, and the glyph that survives a narrow column.
    expect(add.textContent).toContain('Add repository')
    expect(add.querySelector('svg')).toBeTruthy()
    // No ⌘K hint, no second search control — AppShell binds the chord globally.
    expect(view.container.querySelector('[data-testid="palette-hint"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull()
  })
})

describe('a project with nothing in it', () => {
  it('keeps its band and offers one quiet door', () => {
    render(<SidebarUnified />)
    const bands = screen.getAllByTestId('project-group-label').map((band) => band.textContent)
    expect(bands.some((label) => label?.includes('podium'))).toBe(true)
    expect(bands.some((label) => label?.includes('spare'))).toBe(true)
    expect(screen.getAllByTestId('start-first-task')).toHaveLength(1)
  })

  it('points the composer at the project whose band was clicked', () => {
    render(<SidebarUnified />)
    fireEvent.click(screen.getByTestId('start-first-task'))

    expect(draft().repoPath).toBe('/work/spare')
    expect(setSelectedIssueId).toHaveBeenCalledWith(null)
  })

  it('leaves the band out while a filter is narrowing the column', () => {
    render(<SidebarUnified />)
    fireEvent.change(screen.getByTestId('work-search-input'), { target: { value: 'alpha' } })
    // An empty band is not an answer to a query about tasks.
    expect(screen.queryByTestId('start-first-task')).toBeNull()
  })
})
