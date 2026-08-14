// @vitest-environment happy-dom
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/terminal/AgentPanel', () => ({
  AgentPanel: ({ sessionId }: { sessionId: SessionId }): JSX.Element => (
    // A stand-in for the panel's real input surface (terminal / composer): the
    // promotion seam listens on the panel's SUBTREE, not on the wrapper itself.
    <textarea data-panel={sessionId} readOnly value="" />
  ),
}))

vi.mock('@/features/terminal/use-warm-set', () => ({
  useWarmSet: (all: string[]) => new Set(all),
}))

vi.mock('./NewPanelMenu', () => ({
  NewPanelMenu: ({ trigger }: { trigger: JSX.Element }): JSX.Element => trigger,
}))

vi.mock('./operator-focus', () => ({
  useOperatorFocus: () => ({ focusedIssueId: null, setFocusedIssueId: vi.fn() }),
}))

const featureEnabled = { 'tab-splitting': false } as Record<string, boolean>
vi.mock('@/lib/use-feature', () => ({
  useFeature: (id: string) => featureEnabled[id] === true,
}))

const task = {
  id: 'task-1',
  title: 'The task',
  repoPath: '/repo',
  worktreePath: '/repo/wt',
} as IssueWire

const session = (id: string): SessionMeta =>
  ({
    sessionId: asSessionId(id),
    cwd: '/repo/wt',
    issueId: task.id,
    archived: false,
    status: 'live',
    agentKind: 'claude-code',
    name: id,
  }) as SessionMeta

// s1 permanent, s2 the workspace's ONE preview tab and the active one, s3 a
// running session with no tab at all — it belongs to the flight deck.
const makeLayout = () => ({
  key: 'mission:task-1',
  panes: { p1: { id: 'p1', tabs: ['s1', 's2'], activeTabId: 's2' } },
  root: { kind: 'leaf' as const, paneId: 'p1' },
  focusedPaneId: 'p1',
  previewTabId: 's2' as string | null,
})

// p1 holds s1; p2 holds s2 + s3 and is the FOCUSED pane — which is what makes
// the flag-off case interesting: the pane the operator was last in is the one
// the flag hides.
const makeSplitLayout = () => ({
  key: 'mission:task-1',
  panes: {
    p1: { id: 'p1', tabs: ['s1'], activeTabId: 's1' },
    p2: { id: 'p2', tabs: ['s2', 's3'], activeTabId: 's3' },
  },
  root: {
    kind: 'split' as const,
    axis: 'row' as const,
    children: [
      { kind: 'leaf' as const, paneId: 'p1' },
      { kind: 'leaf' as const, paneId: 'p2' },
    ],
    sizes: [0.5, 0.5],
  },
  focusedPaneId: 'p2',
  previewTabId: null as string | null,
})

const actions = {
  setPane: vi.fn(),
  toggleSplit: vi.fn(),
  setSplitEnabled: vi.fn(),
  closeFileTab: vi.fn(),
  markSessionRead: vi.fn(),
  renameSession: vi.fn(),
  openSessionTab: vi.fn(),
  openTabInWorkspace: vi.fn(),
  promoteWorkspaceTab: vi.fn(),
  activateWorkspaceTab: vi.fn(),
  closeWorkspaceTab: vi.fn(),
  moveWorkspaceTab: vi.fn(),
  splitWorkspacePane: vi.fn(),
  closeWorkspacePane: vi.fn(),
  focusWorkspacePane: vi.fn(),
  resizeWorkspaceSplit: vi.fn(),
}

let state: Record<string, unknown>

/** The REPLICA-derived issue list — deliberately separate from what the engine
 *  keys workspaces by, because the two can disagree mid-cutover (POD-710 §4). */
let replicaIssues: IssueWire[] = [task]

vi.mock('./store', () => ({
  useStoreSelector: (selector: (s: Record<string, unknown>) => unknown) => selector(state),
  useReplicaIssues: () => replicaIssues,
}))

const { Workspace } = await import('./Workspace')
const { DesktopCloseTab } = await import('./use-desktop-close-tab')
const { getHoveredSession, setHoveredSession } = await import('./session-hover')

beforeEach(() => {
  featureEnabled['tab-splitting'] = false
  replicaIssues = [task]
  state = {
    sessions: [session('s1'), session('s2'), session('s3')],
    selectedWorktree: '/repo/wt',
    selectedIssueId: task.id,
    paneA: 's2',
    paneB: null,
    split: false,
    fileTabs: [],
    repos: [
      {
        path: '/repo',
        kind: 'repository' as const,
        repoId: 'repo-1',
        worktrees: [{ path: '/repo/wt', branch: 'issue/task-1' }],
      },
    ],
    dockShells: {},
    workspaces: { 'mission:task-1': makeLayout() },
    // The ENGINE resolves the key; the strip never spells it itself (POD-710).
    workspaceKey: () => 'mission:task-1',
    ...actions,
  }
})

afterEach(() => {
  cleanup()
  setHoveredSession(null)
  for (const fn of Object.values(actions)) fn.mockClear()
})

const strip = (): HTMLElement => screen.getByTestId('native-tab-strip')
const tab = (id: string): HTMLElement => {
  const el = strip().querySelector(`[data-session="${id}"]`)
  if (!el) throw new Error(`no tab for ${id}`)
  return el as HTMLElement
}
/** A tab's label control — the first button inside it, before the ✕. */
const label = (id: string): HTMLElement => {
  const el = tab(id).querySelector('button')
  if (!el) throw new Error(`no label for ${id}`)
  return el
}

describe('Workspace tab strip', () => {
  // The decoupling: membership comes from the workspace layout, not from "every
  // session in the mission". s3 is live and in this task — and has no tab.
  it('renders the focused pane, not the mission session list', () => {
    render(<Workspace />)

    const ids = [...strip().querySelectorAll('[data-session]')].map((el) =>
      el.getAttribute('data-session'),
    )
    expect(ids).toEqual(['s1', 's2'])
  })

  it('renders the preview tab italic and leaves permanent tabs upright', () => {
    render(<Workspace />)

    expect(label('s2').className).toContain('italic')
    expect(label('s1').className).not.toContain('italic')
  })

  // The strip and the engine used to key the workspace from two different issue
  // collections — identical walks over `useReplicaIssues()` and `st.issues`,
  // which agree only while the collections do. During the additive projection
  // cutover a legacy row can arrive before its normalized view, and for that
  // interval the strip read `issue:…` while the engine wrote `mission:…`: an
  // empty strip over a panel rendering normally.
  it('reads the workspace at the key the ENGINE resolves, not one of its own', () => {
    replicaIssues = [] // the mission is not visible to the view's collection yet
    render(<Workspace />)

    const ids = [...strip().querySelectorAll('[data-session]')].map((el) =>
      el.getAttribute('data-session'),
    )
    expect(ids).toEqual(['s1', 's2'])
  })

  it('activates a tab on click without promoting it', () => {
    render(<Workspace />)

    fireEvent.click(label('s1'))

    expect(actions.activateWorkspaceTab).toHaveBeenCalledWith('s1')
    expect(actions.promoteWorkspaceTab).not.toHaveBeenCalled()
  })

  // POD-1067: the strip publishes what the pointer is on so the deck can mark
  // the same session's row. A view operation only — nothing is selected, and
  // the pointer leaving is the whole lifetime of it.
  it('publishes the pointed session while the pointer is on its tab', () => {
    render(<Workspace />)

    fireEvent.pointerOver(tab('s1'), { pointerType: 'mouse' })
    expect(getHoveredSession()).toBe('s1')

    fireEvent.pointerOut(tab('s1'), { pointerType: 'mouse' })
    expect(getHoveredSession()).toBeNull()
  })

  it('leaves the deck alone for a touch, which is a tap and not a hover', () => {
    render(<Workspace />)

    fireEvent.pointerOver(tab('s1'), { pointerType: 'touch' })

    expect(getHoveredSession()).toBeNull()
  })

  // A tab that goes away under the pointer (closed, or an issue switch) never
  // gets its leave — so unmounting ends the hover it owns.
  it('ends the hover when the pointed tab unmounts', () => {
    const view = render(<Workspace />)

    fireEvent.pointerOver(tab('s1'), { pointerType: 'mouse' })
    expect(getHoveredSession()).toBe('s1')

    view.unmount()
    expect(getHoveredSession()).toBeNull()
  })
})

describe('Workspace tab closing', () => {
  // POD-710: the lock is gone. Every tab closes, and closing one is a VIEW
  // operation — nothing reaches the session behind it.
  it('closes a session tab without touching the session', () => {
    render(<Workspace />)

    fireEvent.click(within(tab('s1')).getByRole('button', { name: 'Close tab' }))

    expect(actions.closeWorkspaceTab).toHaveBeenCalledWith('s1')
    expect(actions.closeFileTab).not.toHaveBeenCalled()
    expect(actions.setPane).not.toHaveBeenCalled()
  })

  // The Tauri shell suppresses its window-level close only while this returns
  // true (apps/desktop/src-tauri/src/main.rs). The hook lives above Workspace so
  // Cmd+W still closes tabs when the issues board is showing.
  it('closes the active tab on Cmd+W and consumes the keystroke', () => {
    render(
      <>
        <DesktopCloseTab />
        <Workspace />
      </>,
    )

    const closeTab = (globalThis as { __PODIUM_CLOSE_TAB__?: () => boolean }).__PODIUM_CLOSE_TAB__
    expect(closeTab?.()).toBe(true)
    expect(actions.closeWorkspaceTab).toHaveBeenCalledWith('s2')
  })

  it('closes a remaining tab when the active one is already gone', () => {
    state.workspaces = {
      'mission:task-1': {
        ...makeLayout(),
        panes: { p1: { id: 'p1', tabs: ['s1'], activeTabId: null as string | null } },
      },
    }
    render(<DesktopCloseTab />)

    const closeTab = (globalThis as { __PODIUM_CLOSE_TAB__?: () => boolean }).__PODIUM_CLOSE_TAB__
    expect(closeTab?.()).toBe(true)
    expect(actions.closeWorkspaceTab).toHaveBeenCalledWith('s1')
  })

  it('does not close the window when the selected issue has no tabs', () => {
    state.workspaces = {
      'mission:task-1': {
        ...makeLayout(),
        panes: { p1: { id: 'p1', tabs: [], activeTabId: null as string | null } },
      },
    }
    render(<DesktopCloseTab />)

    const closeTab = (globalThis as { __PODIUM_CLOSE_TAB__?: () => boolean }).__PODIUM_CLOSE_TAB__
    expect(closeTab?.()).toBe(false)
    expect(actions.closeWorkspaceTab).not.toHaveBeenCalled()
    expect(actions.closeFileTab).not.toHaveBeenCalled()
  })

  it('offers a view-scoped tab menu with no session lifecycle actions', () => {
    render(<Workspace />)

    fireEvent.contextMenu(label('s2'))

    const menu = screen.getByRole('menu', { name: 'Tab actions' })
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((el) =>
      el.textContent?.trim(),
    )
    expect(labels).toEqual(['Close', 'Close Others', 'Close All', 'Keep Open'])

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Keep Open' }))
    expect(actions.promoteWorkspaceTab).toHaveBeenCalledWith('s2')
  })

  it('offers the split items only under the tab-splitting flag', () => {
    featureEnabled['tab-splitting'] = true
    render(<Workspace />)

    fireEvent.contextMenu(label('s2'))
    const menu = screen.getByRole('menu', { name: 'Tab actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Split Right' }))

    expect(actions.splitWorkspacePane).toHaveBeenCalledWith('p1', 'row', { tabId: 's2' })
  })
})

describe('Workspace preview promotion', () => {
  const panel = (id: string): HTMLElement => {
    const el = document.querySelector(`textarea[data-panel="${id}"]`)
    if (!el) throw new Error(`no panel for ${id}`)
    return el as HTMLElement
  }

  it('promotes the preview when the operator types into its panel', () => {
    render(<Workspace />)

    fireEvent.keyDown(panel('s2'), { key: 'a' })

    expect(actions.promoteWorkspaceTab).toHaveBeenCalledWith('s2')
  })

  it('promotes the preview on paste', () => {
    render(<Workspace />)

    fireEvent.paste(panel('s2'))

    expect(actions.promoteWorkspaceTab).toHaveBeenCalledWith('s2')
  })

  // Reading gestures leave the tab temporary — that is what makes cycling
  // through sessions in the flight deck cheap.
  it('leaves the preview alone for a bare modifier, a click or a scroll', () => {
    render(<Workspace />)

    fireEvent.keyDown(panel('s2'), { key: 'Shift' })
    fireEvent.click(panel('s2'))
    fireEvent.scroll(panel('s2'))
    fireEvent.focus(panel('s2'))

    expect(actions.promoteWorkspaceTab).not.toHaveBeenCalled()
  })

  it('never promotes a permanent tab', () => {
    state.workspaces = {
      'mission:task-1': { ...makeLayout(), previewTabId: null },
    }
    render(<Workspace />)

    fireEvent.keyDown(panel('s2'), { key: 'a' })

    expect(actions.promoteWorkspaceTab).not.toHaveBeenCalled()
  })
})

describe('Workspace splitting', () => {
  const strips = (): HTMLElement[] => screen.getAllByTestId('native-tab-strip')
  /** A mounted PANEL (not a strip tab): only panels carry `data-pane`, and only
   *  while they are the active tab of a pane that is on screen. */
  const panel = (id: string): Element | null => document.querySelector(`div[data-session="${id}"]`)
  const visiblePane = (id: string): string | null => panel(id)?.getAttribute('data-pane') ?? null

  beforeEach(() => {
    state.workspaces = { 'mission:task-1': makeSplitLayout() }
  })

  it('renders every pane with its own strip when the flag is on', () => {
    featureEnabled['tab-splitting'] = true
    render(<Workspace />)

    expect(strips().map((s) => s.getAttribute('data-pane'))).toEqual(['p1', 'p2'])
    const second = [...(strips()[1] as HTMLElement).querySelectorAll('[data-session]')]
    expect(second.map((el) => el.getAttribute('data-session'))).toEqual(['s2', 's3'])
    // Each pane shows its own active tab.
    expect(visiblePane('s1')).toBe('p1')
    expect(visiblePane('s3')).toBe('p2')
  })

  // The flag boundary: the layout is PRESERVED and only its first leaf is drawn.
  // Nothing collapses panes, and the hidden pane's panel stays mounted so
  // turning the flag back on is a reveal rather than a remount.
  it('renders the first leaf only when the flag is off, without touching the layout', () => {
    featureEnabled['tab-splitting'] = false
    render(<Workspace />)

    expect(strips()).toHaveLength(1)
    expect(strips()[0]?.getAttribute('data-pane')).toBe('p1')
    expect(visiblePane('s1')).toBe('p1')
    expect(visiblePane('s3')).toBeNull()
    expect(panel('s3')?.className).toContain('hidden')
    expect(actions.closeWorkspacePane).not.toHaveBeenCalled()
    expect(actions.moveWorkspaceTab).not.toHaveBeenCalled()
    expect(actions.splitWorkspacePane).not.toHaveBeenCalled()
  })

  // An off-screen focused pane would have the client report a session the
  // operator cannot see as focused — clearing its unread badge and claiming PTY
  // relay for it. Focus follows the screen instead.
  it('moves focus onto the visible pane when the flag hides the focused one', () => {
    featureEnabled['tab-splitting'] = false
    render(<Workspace />)

    expect(actions.focusWorkspacePane).toHaveBeenCalledWith('p1')
  })

  // The engine may not read a feature flag, and it may not assume a preserved
  // split layout is all on screen — so the surface that owns the flag tells it.
  // Without this the hidden pane's session took PTY-relay priority and had its
  // unread badge cleared by the mark-read reaction.
  it('tells the engine whether the second pane is on screen', () => {
    featureEnabled['tab-splitting'] = false
    const { unmount } = render(<Workspace />)
    expect(actions.setSplitEnabled).toHaveBeenLastCalledWith(false)

    unmount()
    featureEnabled['tab-splitting'] = true
    render(<Workspace />)
    expect(actions.setSplitEnabled).toHaveBeenLastCalledWith(true)
  })

  it('focuses a pane when the operator points into its strip', () => {
    featureEnabled['tab-splitting'] = true
    render(<Workspace />)

    fireEvent.pointerDown(strips()[0] as HTMLElement)

    expect(actions.focusWorkspacePane).toHaveBeenCalledWith('p1')
  })

  it('splits and closes the pane whose strip the control belongs to', () => {
    featureEnabled['tab-splitting'] = true
    render(<Workspace />)

    fireEvent.click(within(strips()[0] as HTMLElement).getByRole('button', { name: 'Split Right' }))
    expect(actions.splitWorkspacePane).toHaveBeenCalledWith('p1', 'row', { tabId: undefined })

    fireEvent.click(within(strips()[1] as HTMLElement).getByRole('button', { name: 'Close pane' }))
    expect(actions.closeWorkspacePane).toHaveBeenCalledWith('p2')
  })

  it('offers no split controls at all with the flag off', () => {
    featureEnabled['tab-splitting'] = false
    render(<Workspace />)

    expect(screen.queryByRole('button', { name: 'Split Right' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize panes' })).toBeNull()
  })

  it('resizes the split from the keyboard, into the layout', () => {
    featureEnabled['tab-splitting'] = true
    render(<Workspace />)

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize panes' }), {
      key: 'ArrowRight',
    })

    const call = actions.resizeWorkspaceSplit.mock.calls[0] as [number[], number[]]
    expect(call[0]).toEqual([])
    expect(call[1][0]).toBeCloseTo(0.52)
    expect(call[1][1]).toBeCloseTo(0.48)
  })
})
