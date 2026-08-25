// @vitest-environment happy-dom
/**
 * THE INLINE FILTER (POD-1078, the 3b sidebar): the field between the spawn row
 * and the list, its ⌘F chord, and what the column does when a query matches
 * nothing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function issue(id: string, title: string, seq: number, over: Record<string, unknown> = {}) {
  return {
    id,
    repoPath: '/repo',
    seq,
    // The real rows carry a project-prefixed ref, and it is the form a person
    // pastes in from a commit message or a chat — so the fixture carries it too.
    displayRef: `POD-${seq}`,
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

vi.mock('@/app/store', () => {
  const useStore = () => ({
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [idleSess('s-pin', 'pin'), idleSess('s-a', 'alpha'), idleSess('s-b', 'beta')],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      issue('pin', 'Pinned rocket', 700, { pinned: true }),
      issue('alpha', 'Alpha lander', 844),
      issue('beta', 'Beta rocket', 969),
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
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

function field(): HTMLInputElement {
  return screen.getByTestId('work-search-input') as HTMLInputElement
}

function type(value: string): void {
  fireEvent.change(field(), { target: { value } })
}

function titles(): string[] {
  return screen
    .queryAllByTestId('unified-issue-row')
    .map((row) => row.querySelector('.shell-work-row-title')?.textContent ?? '')
}

async function expectTitles(expected: string[]): Promise<void> {
  await waitFor(() => expect(titles()).toEqual(expected))
}

afterEach(() => {
  cleanup()
  ui.reset()
  delete (globalThis as { __PODIUM_DESKTOP__?: unknown }).__PODIUM_DESKTOP__
})

describe('SidebarUnified inline filter (POD-1078)', () => {
  it('advertises the chord until there is a query, then counts the hits', async () => {
    // The macOS shell — the hint is spelled for the keyboard in front of it
    // (POD-1532), and happy-dom's own platform is not Apple.
    const bridge = globalThis as { __PODIUM_DESKTOP__?: { platform: string } }
    bridge.__PODIUM_DESKTOP__ = { platform: 'macos' }
    render(<SidebarUnified />)
    // The counter IS the affordance: it names the shortcut that focuses the
    // field, so nothing else has to carry a hint for it.
    expect(screen.getByTestId('work-search-count').textContent).toBe('⌘F')
    type('rocket')
    expect(field().value).toBe('rocket')
    await waitFor(() => expect(screen.getByTestId('work-search-count').textContent).toBe('2/3'))
  })

  it('spells that chord Ctrl+F on Linux, where there is no Command key', () => {
    const bridge = globalThis as { __PODIUM_DESKTOP__?: { platform: string } }
    bridge.__PODIUM_DESKTOP__ = { platform: 'linux' }
    render(<SidebarUnified />)
    expect(screen.getByTestId('work-search-count').textContent).toBe('Ctrl+F')
  })

  it('narrows the list to matching rows, across the pinned section and the groups', async () => {
    render(<SidebarUnified />)
    expect(titles()).toEqual(['Pinned rocket', 'Beta rocket', 'Alpha lander'])
    type('lander')
    // The field commits on the urgent path. Only the expensive row tree waits
    // for the deferred query.
    expect(field().value).toBe('lander')
    await expectTitles(['Alpha lander'])
    // A section with no hit leaves whole: an empty band under a filter is chrome
    // claiming a group with nothing to show.
    expect(screen.queryByTestId('pinned-section')).toBeNull()
  })

  it('matches on the ref as well as the title — the number is what people paste', async () => {
    render(<SidebarUnified />)
    type('969')
    await expectTitles(['Beta rocket'])
    type('POD-844')
    await expectTitles(['Alpha lander'])
  })

  it('is case-insensitive and ignores surrounding whitespace', async () => {
    render(<SidebarUnified />)
    type('  ALPHA ')
    await expectTitles(['Alpha lander'])
  })

  it('says no matches rather than borrowing the empty-list ghost', async () => {
    render(<SidebarUnified />)
    type('zzzz')
    await expectTitles([])
    expect(screen.getByTestId('work-filter-empty')).toBeTruthy()
    // The ghost claims "nothing is here yet", which would be a lie about a
    // column holding three rows this query happens to miss.
    expect(screen.queryByTestId('work-ghost-rows')).toBeNull()
  })

  it('names the haystack under a filtered list, and only while filtering', async () => {
    render(<SidebarUnified />)
    expect(screen.queryByTestId('work-filter-footnote')).toBeNull()
    type('rocket')
    expect((await screen.findByTestId('work-filter-footnote')).textContent).toContain(
      'searching 3 tasks',
    )
  })

  it('clears back to the whole column, and hands focus back to the field', async () => {
    render(<SidebarUnified />)
    type('lander')
    await expectTitles(['Alpha lander'])
    fireEvent.click(screen.getByTestId('work-search-clear'))
    expect(document.activeElement).toBe(field())
    expect(field().value).toBe('')
    await waitFor(() => expect(titles()).toHaveLength(3))
    // Escape is the keyboard's version of the same button.
    type('lander')
    await expectTitles(['Alpha lander'])
    fireEvent.keyDown(field(), { key: 'Escape' })
    await waitFor(() => expect(titles()).toHaveLength(3))
  })

  it('focuses and selects the field on ⌘F, and on Ctrl+F off the Mac', () => {
    render(<SidebarUnified />)
    type('lander')
    field().blur()
    expect(document.activeElement).not.toBe(field())
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(document.activeElement).toBe(field())
    // Selected, not appended: ⌘F on a field that already holds a query means
    // "search for something else".
    expect(field().selectionStart).toBe(0)
    expect(field().selectionEnd).toBe('lander'.length)
    field().blur()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(field())
  })

  it('leaves the chord alone when it carries another modifier', () => {
    render(<SidebarUnified />)
    field().blur()
    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    expect(document.activeElement).not.toBe(field())
  })

  it('withdraws the reorder grips while a query is narrowing the column (POD-1102)', async () => {
    render(<SidebarUnified />)
    expect(document.querySelectorAll('[data-drag-key]')).toHaveLength(3)
    // A filtered column is a VIEW, not the scope. The drop reads the new order
    // back out of `data-drag-key`, so leaving grips on a narrowed list plans a
    // sortKey write against a sample of the siblings — the hidden rows between
    // the visible ones are invisible to the plan, and the backfill path would
    // renumber the sample and scatter everything it could not see.
    type('rocket')
    await waitFor(() => expect(document.querySelectorAll('[data-drag-key]')).toHaveLength(0))
    fireEvent.click(screen.getByTestId('work-search-clear'))
    await waitFor(() => expect(document.querySelectorAll('[data-drag-key]')).toHaveLength(3))
  })

  it('gaps every section but the first (the design’s 14px)', () => {
    render(<SidebarUnified />)
    // Pinned opens the column, flush under the search field; the project group
    // under it takes the gap.
    expect(screen.getByTestId('pinned-section').className).not.toContain('mt-[14px]')
    expect(screen.getByTestId('project-group').className).toContain('mt-[14px]')
  })
})
