// @vitest-environment happy-dom
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVEAL_IN_DECK_EVENT } from './shell-state'

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

vi.mock('./NewPanelMenu', async () => {
  const { cloneElement, useState } = await import('react')
  return {
    NewPanelMenu: ({ trigger }: { trigger: JSX.Element }): JSX.Element => {
      const [open, setOpen] = useState(false)
      return (
        <>
          {cloneElement(trigger, { onClick: () => setOpen(true) })}
          {open ? <div role="menu" aria-label="New panel menu" /> : null}
        </>
      )
    },
  }
})

vi.mock('./operator-focus', () => ({
  useOperatorFocus: () => ({ focusedIssueId: null, setFocusedIssueId: vi.fn() }),
}))

vi.mock('@/lib/use-feature', () => ({
  useFeature: () => false,
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

const delayedDragRuntime = () => {
  type DragRuntimeModule = typeof import('./workspace-tab-drag')
  let resolve!: (module: DragRuntimeModule) => void
  let reject!: (reason: Error) => void
  const load = vi.fn(
    () =>
      new Promise<DragRuntimeModule>((done, fail) => {
        resolve = done
        reject = fail
      }),
  )
  return {
    load,
    release: async (): Promise<void> => resolve(await import('./workspace-tab-drag')),
    reject: async (reason = new Error('chunk request failed')): Promise<void> => {
      reject(reason)
      await Promise.resolve()
    },
  }
}

beforeEach(() => {
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
  it('keeps dnd-kit cold through startup and loads it on the first draggable-tab intent', async () => {
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)

    expect(strip().getAttribute('data-drag-runtime')).toBeNull()
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    expect(runtime.load).not.toHaveBeenCalled()

    fireEvent.pointerEnter(tab('s1'))
    expect(runtime.load).toHaveBeenCalledTimes(1)
    await runtime.release()
    await waitFor(() => expect(strip().getAttribute('data-drag-runtime')).toBe('ready'))
  })

  it('retries the drag runtime on the next intent after a rejected request', async () => {
    const runtime = delayedDragRuntime()
    let rejectFirstRequest!: (reason: Error) => void
    const load = vi
      .fn<() => ReturnType<typeof runtime.load>>()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirstRequest = reject
          }),
      )
      .mockImplementation(runtime.load)
    render(<Workspace loadDragRuntime={load} />)

    fireEvent.pointerEnter(tab('s1'))
    expect(load).toHaveBeenCalledTimes(1)
    rejectFirstRequest(new Error('chunk request failed'))
    await Promise.resolve()

    fireEvent.pointerEnter(tab('s1'))
    expect(load).toHaveBeenCalledTimes(2)
    await runtime.release()
    await waitFor(() => expect(strip().getAttribute('data-drag-runtime')).toBe('ready'))
  })

  it('cancels a threshold-crossed cold pointer drag when the runtime request rejects', async () => {
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const source = document.querySelector<HTMLElement>('[data-tab-drag-id="s1"]')
    if (!source) throw new Error('no source tab')

    fireEvent.pointerDown(source, {
      pointerId: 2,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
    })
    fireEvent.pointerMove(document, {
      pointerId: 2,
      pointerType: 'mouse',
      isPrimary: true,
      buttons: 1,
      clientX: 16,
      clientY: 10,
    })
    await runtime.reject()

    fireEvent.click(label('s1'))
    expect(actions.activateWorkspaceTab).toHaveBeenCalledWith('s1')

    fireEvent.pointerEnter(tab('s1'))
    expect(runtime.load).toHaveBeenCalledTimes(2)
    await runtime.release()
    await waitFor(() => expect(strip().getAttribute('data-drag-runtime')).toBe('ready'))
    expect(document.querySelector('[data-dropzone]')).toBeNull()
  })

  it('cancels a cold keyboard pickup when the runtime request rejects', async () => {
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const sortable = tab('s1')
    sortable.focus()

    fireEvent.keyDown(sortable, { key: ' ', code: 'Space' })
    await runtime.reject()

    const arrow = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      code: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(arrow)
    expect(arrow.defaultPrevented).toBe(false)

    fireEvent.pointerEnter(tab('s1'))
    expect(runtime.load).toHaveBeenCalledTimes(2)
    await runtime.release()
    await waitFor(() => expect(strip().getAttribute('data-drag-runtime')).toBe('ready'))
    expect(document.querySelector('[data-dropzone]')).toBeNull()
  })

  it.each([
    'mouse',
    'touch',
  ])('replays the first cold %s drag after a delayed runtime import', async (pointerType) => {
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const source = document.querySelector<HTMLElement>('[data-tab-drag-id="s1"]')
    if (!source) throw new Error('no source tab')

    fireEvent.pointerDown(source, {
      pointerId: 1,
      pointerType,
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
    })
    fireEvent.pointerMove(document, {
      pointerId: 1,
      pointerType,
      isPrimary: true,
      buttons: 1,
      clientX: 16,
      clientY: 10,
    })

    expect(runtime.load).toHaveBeenCalledTimes(1)
    expect(strip().getAttribute('data-drag-runtime')).toBeNull()
    expect(document.querySelector('[data-dropzone]')).toBeNull()

    await runtime.release()
    await waitFor(() => expect(document.querySelector('[data-dropzone]')).toBeTruthy())
    fireEvent.pointerCancel(document, { pointerId: 1, pointerType, isPrimary: true })
    await waitFor(() => expect(document.querySelector('[data-dropzone]')).toBeNull())
  })

  it.each([
    { pointerType: 'mouse', control: 'label' },
    { pointerType: 'mouse', control: 'close' },
    { pointerType: 'touch', control: 'label' },
    { pointerType: 'touch', control: 'close' },
  ] as const)(
    'keeps a cold $pointerType $control press at five pixels when the runtime arrives before release',
    async ({ pointerType, control }) => {
      const runtime = delayedDragRuntime()
      render(<Workspace loadDragRuntime={runtime.load} />)
      const original =
        control === 'label'
          ? label('s1')
          : within(tab('s1')).getByRole('button', { name: 'Close tab' })
      original.focus()

      fireEvent.pointerDown(original, {
        pointerId: 3,
        pointerType,
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: 10,
        clientY: 10,
      })
      fireEvent.pointerMove(document, {
        pointerId: 3,
        pointerType,
        isPrimary: true,
        buttons: 1,
        clientX: 15,
        clientY: 10,
      })

      await runtime.release()
      await waitFor(() => expect(strip().getAttribute('data-drag-runtime')).toBe('ready'))
      const replacement =
        control === 'label'
          ? label('s1')
          : within(tab('s1')).getByRole('button', { name: 'Close tab' })
      expect(original.isConnected).toBe(false)
      expect(document.activeElement).toBe(replacement)

      fireEvent.pointerUp(document, {
        pointerId: 3,
        pointerType,
        isPrimary: true,
        button: 0,
        buttons: 0,
        clientX: 15,
        clientY: 10,
      })

      if (control === 'label') {
        await waitFor(() => expect(actions.activateWorkspaceTab).toHaveBeenCalledWith('s1'))
        expect(actions.closeWorkspaceTab).not.toHaveBeenCalled()
      } else {
        await waitFor(() => expect(actions.closeWorkspaceTab).toHaveBeenCalledWith('s1'))
        expect(actions.activateWorkspaceTab).not.toHaveBeenCalled()
      }
      expect(document.querySelector('[data-dropzone]')).toBeNull()
    },
  )

  it('drops a pointer activation cancelled before readiness', async () => {
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)

    fireEvent.pointerDown(tab('s1'), {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
    })
    fireEvent.pointerMove(document, {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      buttons: 1,
      clientX: 30,
      clientY: 10,
    })
    fireEvent.pointerCancel(document, { pointerId: 7, pointerType: 'touch', isPrimary: true })
    await runtime.release()

    await waitFor(() => expect(strip().getAttribute('data-drag-runtime')).toBe('ready'))
    expect(document.querySelector('[data-dropzone]')).toBeNull()
  })

  it('replays the first cold Space pickup, restores focus, and cancels with Escape', async () => {
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const sortable = tab('s1')
    sortable.focus()

    fireEvent.keyDown(sortable, { key: ' ', code: 'Space' })
    expect(strip().getAttribute('data-drag-runtime')).toBeNull()
    await runtime.release()
    await waitFor(() => expect(document.querySelector('[data-dropzone]')).toBeTruthy())
    expect(document.activeElement?.getAttribute('data-tab-drag-id')).toBe('s1')

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-dropzone]')).toBeNull())
    expect(document.activeElement?.getAttribute('data-tab-drag-id')).toBe('s1')
  })

  it('drops a cold Space pickup cancelled before readiness and restores focus', async () => {
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const sortable = tab('s1')
    sortable.focus()

    fireEvent.keyDown(sortable, { key: ' ', code: 'Space' })
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await runtime.release()

    await waitFor(() => expect(strip().getAttribute('data-drag-runtime')).toBe('ready'))
    expect(document.querySelector('[data-dropzone]')).toBeNull()
    expect(sortable.isConnected).toBe(false)
    expect(document.activeElement).toBe(tab('s1'))
  })

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
    // "Close tab" names its noun (POD-1077) because the session menu spells its
    // terminal action "Delete session…" — two menus a few pixels apart must not
    // both offer a bare "Close" meaning a view-close and a tombstone.
    // "Reveal in flight deck" is NAVIGATION, not lifecycle: it moves you to the
    // row that owns those verbs instead of copying them onto a tab.
    expect(labels).toEqual([
      'Close tab',
      'Close Others',
      'Close All',
      'Keep Open',
      'Split Right',
      'Split Down',
      'Reveal in flight deck',
    ])
    // The POD-710 invariant this test exists for, asserted directly rather than
    // implied by the list above.
    for (const forbidden of [/hibernate/i, /archive/i, /delete/i, /end session/i, /handoff/i]) {
      expect(labels.some((text) => text !== undefined && forbidden.test(text))).toBe(false)
    }

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Keep Open' }))
    expect(actions.promoteWorkspaceTab).toHaveBeenCalledWith('s2')
  })

  // A file tab has no session behind it and so gets no reveal (POD-1077). Not
  // covered here: this suite's fixture carries no file tabs, and the gate is a
  // typed optional prop set only for `tab.kind === 'session'`.

  it('reveals the session behind a tab in the flight deck (POD-1077)', () => {
    render(<Workspace />)
    const revealed = vi.fn()
    window.addEventListener(REVEAL_IN_DECK_EVENT, revealed)

    fireEvent.contextMenu(label('s2'))
    const menu = screen.getByRole('menu', { name: 'Tab actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reveal in flight deck' }))

    expect(revealed).toHaveBeenCalledTimes(1)
    expect((revealed.mock.calls[0]?.[0] as CustomEvent<string>).detail).toBe('s2')
    window.removeEventListener(REVEAL_IN_DECK_EVENT, revealed)
  })

  it('offers the split items in the tab menu', () => {
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

  it.each([
    { name: 'New panel', pane: 0, action: 'new' },
    { name: 'Split Right', pane: 0, action: 'split' },
    { name: 'Close pane', pane: 1, action: 'close' },
  ] as const)(
    'keeps the cold $name action connected through focus and click',
    ({ name, pane, action }) => {
      featureEnabled['tab-splitting'] = true
      const runtime = delayedDragRuntime()
      render(<Workspace loadDragRuntime={runtime.load} />)
      const control = within(strips()[pane] as HTMLElement).getByRole('button', { name })
      const clicked = vi.fn()
      control.addEventListener('click', clicked)

      control.focus()
      fireEvent.pointerEnter(control, { pointerType: 'mouse' })
      fireEvent.pointerMove(control, { pointerType: 'mouse' })
      fireEvent.pointerDown(control, {
        pointerId: 11,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
      })

      expect(runtime.load).not.toHaveBeenCalled()
      expect(control.isConnected).toBe(true)
      expect(document.activeElement).toBe(control)

      fireEvent.pointerUp(control, {
        pointerId: 11,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
      })
      fireEvent.click(control)

      expect(clicked).toHaveBeenCalledTimes(1)
      if (action === 'split') {
        expect(actions.splitWorkspacePane).toHaveBeenCalledWith('p1', 'row', { tabId: undefined })
      } else if (action === 'close') {
        expect(actions.closeWorkspacePane).toHaveBeenCalledWith('p2')
      }
    },
  )

  it.each([
    { name: 'New panel', pane: 0, action: 'new' },
    { name: 'Split Right', pane: 0, action: 'split' },
    { name: 'Close pane', pane: 1, action: 'close' },
  ] as const)(
    'holds an in-flight drag runtime through the $name press',
    async ({ name, pane, action }) => {
      featureEnabled['tab-splitting'] = true
      const runtime = delayedDragRuntime()
      render(<Workspace loadDragRuntime={runtime.load} />)

      const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
      if (!intentTab) throw new Error('no source tab')
      fireEvent.pointerEnter(intentTab)
      expect(runtime.load).toHaveBeenCalledTimes(1)

      const original = within(strips()[pane] as HTMLElement).getByRole('button', { name })
      const clicked = vi.fn()
      original.addEventListener('click', clicked)
      original.focus()
      fireEvent.pointerDown(original, {
        pointerId: 12,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
      })

      await runtime.release()
      expect(original.isConnected).toBe(true)
      expect(document.activeElement).toBe(original)
      expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()

      fireEvent.pointerUp(original, {
        pointerId: 12,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
      })
      fireEvent.click(original)

      expect(clicked).toHaveBeenCalledTimes(1)
      if (action === 'split') {
        expect(actions.splitWorkspacePane).toHaveBeenCalledWith('p1', 'row', { tabId: undefined })
      } else if (action === 'close') {
        expect(actions.closeWorkspacePane).toHaveBeenCalledWith('p2')
      }

      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()
      expect(original.isConnected).toBe(true)
      expect(document.activeElement).toBe(original)

      fireEvent.pointerEnter(intentTab)
      await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
      const replacement = within(strips()[pane] as HTMLElement).getByRole('button', { name })
      expect(original.isConnected).toBe(false)
      expect(document.activeElement).toBe(replacement)
    },
  )

  it('keeps New panel open when the pending runtime resolves after its click', async () => {
    featureEnabled['tab-splitting'] = true
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
    if (!intentTab) throw new Error('no source tab')
    fireEvent.pointerEnter(intentTab)

    const original = within(strips()[0] as HTMLElement).getByRole('button', { name: 'New panel' })
    original.focus()
    fireEvent.pointerDown(original, {
      pointerId: 13,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
    })
    fireEvent.pointerUp(original, {
      pointerId: 13,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
    })
    fireEvent.click(original)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))

    expect(screen.getByRole('menu', { name: 'New panel menu' })).toBeTruthy()
    expect(original.isConnected).toBe(true)
    expect(document.activeElement).toBe(original)

    await runtime.release()
    await Promise.resolve()
    expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()
    expect(screen.getByRole('menu', { name: 'New panel menu' })).toBeTruthy()
    expect(original.isConnected).toBe(true)

    fireEvent.pointerEnter(intentTab)
    await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
    expect(original.isConnected).toBe(false)
    expect(screen.queryByRole('menu', { name: 'New panel menu' })).toBeNull()
  })

  it('holds an in-flight drag runtime through a fixed action keyboard activation', async () => {
    featureEnabled['tab-splitting'] = true
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
    if (!intentTab) throw new Error('no source tab')
    fireEvent.pointerEnter(intentTab)

    const original = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    original.focus()
    fireEvent.keyDown(original, { key: ' ', code: 'Space' })
    await runtime.release()

    expect(original.isConnected).toBe(true)
    expect(document.activeElement).toBe(original)
    expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()

    fireEvent.keyUp(original, { key: ' ', code: 'Space' })
    fireEvent.click(original)
    expect(actions.splitWorkspacePane).toHaveBeenCalledWith('p1', 'row', { tabId: undefined })

    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()
    expect(original.isConnected).toBe(true)

    fireEvent.pointerEnter(intentTab)
    await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
    const replacement = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    expect(original.isConnected).toBe(false)
    expect(document.activeElement).toBe(replacement)
  })

  it('does not replay a cold Space pickup after a fixed action takes ownership', async () => {
    featureEnabled['tab-splitting'] = true
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
    if (!intentTab) throw new Error('no source tab')
    intentTab.focus()

    fireEvent.keyDown(intentTab, { key: ' ', code: 'Space' })
    expect(runtime.load).toHaveBeenCalledTimes(1)

    const action = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    action.focus()
    const fixedKeyDown = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    })
    action.dispatchEvent(fixedKeyDown)
    expect(fixedKeyDown.defaultPrevented).toBe(false)
    await runtime.release()

    expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()
    fireEvent.keyUp(action, { key: ' ', code: 'Space' })
    fireEvent.click(action)
    expect(actions.splitWorkspacePane).toHaveBeenCalledWith('p1', 'row', { tabId: undefined })

    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    fireEvent.pointerEnter(intentTab)
    await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
    expect(document.querySelector('[data-dropzone]')).toBeNull()
  })

  it('keeps fixed-control focus when the runtime resolves before keydown', async () => {
    featureEnabled['tab-splitting'] = true
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
    if (!intentTab) throw new Error('no source tab')
    intentTab.focus()
    expect(runtime.load).toHaveBeenCalledTimes(1)

    const original = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    original.focus()
    await runtime.release()

    await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
    const replacement = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    expect(original.isConnected).toBe(false)
    expect(document.activeElement).toBe(replacement)
  })

  it('releases a fixed pointer hold when pointer capture is lost', async () => {
    featureEnabled['tab-splitting'] = true
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
    if (!intentTab) throw new Error('no source tab')
    fireEvent.pointerEnter(intentTab)

    const control = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    fireEvent.pointerDown(control, {
      pointerId: 14,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
    })
    await runtime.release()
    control.dispatchEvent(
      new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 14, pointerType: 'mouse' }),
    )
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))

    expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()
    fireEvent.pointerEnter(intentTab)
    await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
  })

  it('releases a fixed keyboard hold when the window loses focus', async () => {
    featureEnabled['tab-splitting'] = true
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
    if (!intentTab) throw new Error('no source tab')
    fireEvent.pointerEnter(intentTab)

    const control = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    control.focus()
    fireEvent.keyDown(control, { key: ' ', code: 'Space' })
    await runtime.release()
    window.dispatchEvent(new Event('blur'))
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))

    expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()
    fireEvent.pointerEnter(intentTab)
    await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
  })

  it('clears a fixed pointer hold when the runtime request rejects', async () => {
    featureEnabled['tab-splitting'] = true
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
    if (!intentTab) throw new Error('no source tab')
    fireEvent.pointerEnter(intentTab)

    const control = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    fireEvent.pointerDown(control, {
      pointerId: 15,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
    })
    await runtime.reject()

    fireEvent.pointerEnter(intentTab)
    expect(runtime.load).toHaveBeenCalledTimes(2)
    await runtime.release()
    await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
  })

  it('publishes a runtime requested during an existing fixed pointer hold', async () => {
    featureEnabled['tab-splitting'] = true
    const runtime = delayedDragRuntime()
    render(<Workspace loadDragRuntime={runtime.load} />)
    const intentTab = strips()[0]?.querySelector<HTMLElement>('[data-session="s1"]')
    if (!intentTab) throw new Error('no source tab')

    const control = within(strips()[0] as HTMLElement).getByRole('button', {
      name: 'Split Right',
    })
    fireEvent.pointerDown(control, {
      pointerId: 16,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
    })
    expect(runtime.load).not.toHaveBeenCalled()

    fireEvent.pointerMove(intentTab, {
      pointerId: 16,
      pointerType: 'mouse',
      isPrimary: true,
      buttons: 1,
    })
    expect(runtime.load).toHaveBeenCalledTimes(1)
    await runtime.release()
    fireEvent.pointerUp(intentTab, {
      pointerId: 16,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
    })
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))

    expect(strips()[0]?.getAttribute('data-drag-runtime')).toBeNull()
    fireEvent.pointerEnter(intentTab)
    await waitFor(() => expect(strips()[0]?.getAttribute('data-drag-runtime')).toBe('ready'))
  })

  it.each(['label', 'close'] as const)(
    'finishes a cold drag without dispatching its browser click to the source %s control',
    async (control) => {
      const rect = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          const tabId = this.dataset.tabDragId
          if (tabId === 's1') return new DOMRect(10, 5, 80, 28)
          if (tabId === 's2') return new DOMRect(270, 5, 80, 28)
          if (tabId === 's3') return new DOMRect(355, 5, 80, 28)
          if (this.dataset.testid === 'native-tab-strip') {
            return this.dataset.pane === 'p1'
              ? new DOMRect(0, 0, 250, 38)
              : new DOMRect(250, 0, 250, 38)
          }
          return new DOMRect()
        })
      const runtime = delayedDragRuntime()
      render(<Workspace loadDragRuntime={runtime.load} />)
      const source = document.querySelector<HTMLElement>('[data-tab-drag-id="s1"]')
      if (!source) throw new Error('no source tab')
      const clickTarget =
        control === 'label'
          ? source.querySelector<HTMLElement>('button')
          : within(source).getByRole('button', { name: 'Close tab' })
      if (!clickTarget) throw new Error(`no source ${control} control`)

      fireEvent.pointerDown(clickTarget, {
        pointerId: 9,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 15,
      })
      fireEvent.pointerMove(document, {
        pointerId: 9,
        pointerType: 'mouse',
        isPrimary: true,
        buttons: 1,
        clientX: 480,
        clientY: 15,
      })
      fireEvent.pointerUp(document, {
        pointerId: 9,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
        clientX: 480,
        clientY: 15,
      })
      expect(actions.moveWorkspaceTab).not.toHaveBeenCalled()

      // Browsers dispatch this click from the physical pointerdown/pointerup pair.
      // The deferred runtime has not mounted dnd-kit's own click blocker yet.
      expect(fireEvent.click(clickTarget)).toBe(false)
      expect(actions.activateWorkspaceTab).not.toHaveBeenCalled()
      expect(actions.closeWorkspaceTab).not.toHaveBeenCalled()

      await runtime.release()
      await waitFor(() => expect(actions.moveWorkspaceTab).toHaveBeenCalledWith('s1', 'p2', 2))
      expect(document.querySelector('[data-dropzone]')).toBeNull()
      // PointerSensor keeps its click blocker for 50ms after a completed drag so
      // the release cannot select the tab underneath. Let that documented guard
      // detach before the next test clicks a pane control.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 60))
      rect.mockRestore()
    },
  )

  it('renders every pane with its own strip', () => {
    render(<Workspace />)

    expect(strips().map((s) => s.getAttribute('data-pane'))).toEqual(['p1', 'p2'])
    const second = [...(strips()[1] as HTMLElement).querySelectorAll('[data-session]')]
    expect(second.map((el) => el.getAttribute('data-session'))).toEqual(['s2', 's3'])
    // Each pane shows its own active tab.
    expect(visiblePane('s1')).toBe('p1')
    expect(visiblePane('s3')).toBe('p2')
  })

  // A pane that is off screen keeps its panel MOUNTED but hidden, so the tabs
  // of a pane the operator is not looking at cost no remount when it comes back.
  it('keeps a non-active tab mounted but off screen', () => {
    render(<Workspace />)

    expect(visiblePane('s2')).toBeNull()
    expect(panel('s2')?.className).toContain('hidden')
  })

  it('focuses a pane when the operator points into its strip', () => {
    render(<Workspace />)

    fireEvent.pointerDown(strips()[0] as HTMLElement)

    expect(actions.focusWorkspacePane).toHaveBeenCalledWith('p1')
  })

  it('splits and closes the pane whose strip the control belongs to', () => {
    render(<Workspace />)

    fireEvent.click(within(strips()[0] as HTMLElement).getByRole('button', { name: 'Split Right' }))
    expect(actions.splitWorkspacePane).toHaveBeenCalledWith('p1', 'row', { tabId: undefined })

    fireEvent.click(within(strips()[1] as HTMLElement).getByRole('button', { name: 'Close pane' }))
    expect(actions.closeWorkspacePane).toHaveBeenCalledWith('p2')
  })

  it('resizes the split from the keyboard, into the layout', () => {
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

// The pane the selection left behind (POD-1153): archiving the selected task —
// or leaving the selection on a vessel nobody filled — takes the row out of the
// sidebar and the mission off the deck, and this column has to go cold with
// them rather than offer a ＋ menu with nothing to attach to.
describe('Workspace with no mission on screen', () => {
  const emptyPane = () => ({
    'mission:task-1': {
      ...makeLayout(),
      panes: { p1: { id: 'p1', tabs: [] as string[], activeTabId: null as string | null } },
    },
  })

  it('keeps the empty-pane state while the mission is live', () => {
    state.workspaces = emptyPane()
    render(<Workspace />)

    expect(screen.getByTestId('pane-empty-new-panel')).toBeTruthy()
    expect(screen.queryByTestId('workspace-cold-deck')).toBeNull()
  })

  it('falls back to the cold deck when the selected task is archived', () => {
    replicaIssues = [{ ...task, archived: true } as IssueWire]
    state.workspaces = emptyPane()
    render(<Workspace />)

    expect(screen.getByTestId('workspace-cold-deck')).toBeTruthy()
    expect(screen.queryByTestId('pane-empty-new-panel')).toBeNull()
  })

  it('falls back to the cold deck for a draft vessel nobody filled', () => {
    replicaIssues = [{ ...task, draft: true, worktreePath: null } as IssueWire]
    state.sessions = []
    state.workspaces = emptyPane()
    render(<Workspace />)

    expect(screen.getByTestId('workspace-cold-deck')).toBeTruthy()
  })

  it('renders the open tabs rather than the composer, whatever the selection says', () => {
    replicaIssues = [{ ...task, archived: true } as IssueWire]
    render(<Workspace />)

    expect(screen.queryByTestId('workspace-cold-deck')).toBeNull()
    expect(tab('s1')).toBeTruthy()
  })
})
