// @vitest-environment happy-dom
/**
 * THE COLLAPSED RAIL, REDRAWN (POD-1178, design "ADE Sidebar 3b — Closed").
 *
 * 3a's rail was a 52px strip of 26px squares under bare 1px hairlines, with
 * every word the wide row carried packed into an OS `title`. Five things the
 * design changes, and they are what this file holds:
 *
 *   1. THE GROUPS ARE NAMED. A hairline says a boundary is here; the label says
 *      which project you are looking at — and pinned work gets the same PINNED
 *      section it has in the wide column, so both columns are in the same order
 *      and a ⌘-digit cannot mean two different missions.
 *   2. THE MARK IS A TILE. 36×32, the number set alone. Still `IdSquare`, so
 *      the square language stays central and the colour picker survives.
 *   3. PROGRESS IS ON THE MARK, under the same "two or more tasks" rule the
 *      wide list's baseline rule follows — never on a row that is one task.
 *   4. SELECTION IS A SPINE, not the old gradient notch bridging the border.
 *   5. THE TOOLTIP IS A CARD — title and status phrase — and the native one is
 *      gone, because two tooltips for one gesture is one too many.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarRail } from './SidebarRail'

const ui = vi.hoisted(() => ({
  get: (): string | null => null,
  set: (): void => {},
  subscribe: (): (() => void) => () => {},
}))

const state = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  issues: [] as Record<string, unknown>[],
}))

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

vi.mock('@/app/store', () => {
  const useStore = () => ({
    uiState: ui,
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: state.sessions,
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: state.issues,
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: 'root',
    setSelectedIssueId: vi.fn(),
    setOpenIssueId: vi.fn(),
    setPaletteOpen: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    spawnDraftAgent: vi.fn(),
    updateIssue: vi.fn(async () => {}),
    archiveIssue: vi.fn(async () => {}),
    deleteIssue: vi.fn(async () => {}),
    deferIssue: vi.fn(async () => {}),
    markIssueRead: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}),
    setIssueTucked: vi.fn(async () => {}),
  })
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
  }
})

// The rail's footer search is behind the command-palette flag, and the flag is
// an async trpc read this harness has no server for.
vi.mock('@/lib/use-feature', () => ({ useFeature: () => true }))

afterEach(cleanup)

/** A five-task mission (meter), a lone task (no meter), and a pinned mission
 *  that must hoist out of the project group into its own section. */
const WORK = [
  issue('root', 'Operator workspace', { childCount: 3, seq: 41 }),
  issue('a', 'Flight deck spine', { parentId: 'root', seq: 42, stage: 'done' }),
  issue('b', 'Task inspector', { parentId: 'root', seq: 43, stage: 'done' }),
  issue('c', 'Native lifecycle', { parentId: 'root', seq: 44 }),
  issue('d', 'Row renderer', { parentId: 'root', seq: 45 }),
  issue('solo', 'Sidebar unread dot', { seq: 46 }),
  // In review with nothing blocking it: a decision the human owes, which is
  // exactly what the footer counts.
  issue('kept', 'Ship stack', { seq: 47, pinned: true, stage: 'review' }),
]

const setUp = (issues = WORK): void => {
  state.sessions = []
  state.issues = issues
}

const tiles = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="issue-id-square"]'),
]

const tileFor = (container: HTMLElement, number: string): HTMLElement => {
  const found = tiles(container).find((tile) => tile.dataset.number === number)
  if (!found) throw new Error(`no rail tile for #${number}`)
  return found
}

describe('the collapsed rail, design 3b (POD-1178)', () => {
  it('names its groups instead of drawing bare hairlines, pinned section first', () => {
    setUp()
    const view = render(<SidebarRail />)
    expect(view.container.querySelector('[data-testid="rail-project-hairline"]')).toBeNull()
    const labels = [...screen.getAllByTestId('rail-group-label')].map((el) => el.textContent)
    expect(labels).toEqual(['Pinned', 'repo'])
  })

  it('draws the identity mark as the design tile: 36×32, 9px corner, number alone', () => {
    setUp()
    const view = render(<SidebarRail />)
    const tile = tileFor(view.container, '41')
    expect(tile.style.width).toBe('36px')
    expect(tile.style.height).toBe('32px')
    expect(tile.style.borderRadius).toBe('9px')
    // The prefix line is gone from the mark — and only from the mark: the ref
    // the operator cites is still what the tile announces.
    expect(tile.textContent).toBe('41')
    expect(tile.getAttribute('aria-label')).toContain('#41')
  })

  it('meters a mission on the mark, and leaves a one-task row bare', () => {
    setUp()
    const view = render(<SidebarRail />)
    const meter = (number: string): Element | null =>
      tileFor(view.container, number).parentElement?.querySelector('[data-testid="rail-progress"]') ??
      null
    expect(meter('41')).not.toBeNull()
    expect(meter('46')).toBeNull()
  })

  it('says selection with the wide row’s spine, not 3a’s bridge notch', () => {
    setUp()
    const view = render(<SidebarRail />)
    expect(view.container.querySelector('[data-testid="bridge-notch"]')).toBeNull()
    const spines = view.container.querySelectorAll('[data-testid="rail-spine"]')
    expect(spines).toHaveLength(1)
    expect(tileFor(view.container, '41').dataset.selected).toBe('true')
  })

  it('replaces the OS tooltip with a card carrying the title and the status line', () => {
    setUp()
    const view = render(<SidebarRail />)
    const tile = tileFor(view.container, '46')
    expect(tile.getAttribute('title')).toBeNull()
    expect(screen.queryByTestId('rail-hover-card')).toBeNull()
    fireEvent.mouseEnter(tile.parentElement as HTMLElement)
    const card = screen.getByTestId('rail-hover-card')
    expect(card.textContent).toContain('#46 Sidebar unread dot')
    fireEvent.mouseLeave(tile.parentElement as HTMLElement)
    expect(screen.queryByTestId('rail-hover-card')).toBeNull()
  })

  // POD-1279: the footer holds the open column's tool pair — search and the ⊞
  // that opens the agent/repo menu — and nothing else. The waiting TOTAL that
  // used to sit under the search is gone: the tiles' own amber badges say the
  // same thing, one mission at a time, where the click that answers it is.
  it('puts the add menu in the footer beside search, not at the top', () => {
    setUp()
    const view = render(<SidebarRail />)
    const footer = view.container.querySelector('[data-testid="rail-new-menu"]')
      ?.parentElement as HTMLElement
    expect(footer).toBeTruthy()
    expect(footer.querySelector('[aria-label="Search"]')).not.toBeNull()
    // The spawn tile stayed at the top; only the ⊞ came down.
    const rail = view.container.querySelector('[data-testid="sidebar-rail"]') as HTMLElement
    const top = view.container.querySelector('[data-testid="rail-new-agent"]') as HTMLElement
    expect(top.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const menu = view.container.querySelector('[data-testid="rail-new-menu"]') as HTMLElement
    expect(rail.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('no longer draws a waiting total in the footer', () => {
    setUp()
    render(<SidebarRail />)
    expect(screen.queryByTestId('rail-waiting-total')).toBeNull()
  })
})
