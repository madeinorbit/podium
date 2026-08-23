import { beginSwitch } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import type { Pane, WorktreeView } from '@podium/client-core/viewmodels'
import {
  allTabIds,
  emptyWorkspace,
  isCoordinatorSession,
  missionIssueIds,
  missionRootFor,
  orphanSessionFor,
  reposToViews,
  resizeSplit,
  type SplitAxis,
  selectedMissionRoot,
} from '@podium/client-core/viewmodels'
import { asSessionId, type IssueId, type SessionId, type SessionMeta } from '@podium/model/browser'
import {
  Columns2,
  Crosshair,
  FileText,
  PanelRightClose,
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from 'lucide-react'
import {
  type ComponentType,
  type JSX,
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { AgentPanel } from '@/features/terminal/AgentPanel'
import { useWarmSet } from '@/features/terminal/use-warm-set'
import { MENU_ITEM, MENU_ITEM_DISABLED, MENU_PANEL, MENU_RULE } from '@/lib/menu-surface'
import { AgentStatusGlyph } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { cn } from '@/lib/utils'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { NewPanelMenu } from './NewPanelMenu'
import { useOperatorFocus } from './operator-focus'
import { PanelDeck } from './PanelDeck'
import {
  composeDeck,
  type DeckTab,
  deckGeometry,
  type PaneRect,
  paneBoxStyle,
  paneDropId,
  panelBoxStyle,
  resizedSizes,
  resolveTabDrop,
  type SplitSeam,
  seamBoxStyle,
  splitDropId,
  stripDropId,
} from './panel-deck'
import { clearHoveredSession, setHoveredSession } from './session-hover'
import { REVEAL_IN_DECK_EVENT } from './shell-state'
import { type FileTab, useReplicaIssues, useStoreSelector } from './store'
import { closeActiveWorkspaceTab } from './workspace-close'
import type {
  PendingTabDragActivation,
  TabDragComponents,
  TabDragItemBindings,
  TabDragKeyboardEventSnapshot,
  TabDragPointerEventSnapshot,
  WorkspaceTabDragRuntimeProps,
} from './workspace-tab-drag'

// The cold-start composer only renders in the empty pane (no issue selected),
// and it fronts the whole first-run setup graph — loading it on demand keeps
// that graph out of the eager bundle.
const ColdStartComposer = lazy(() =>
  import('@/features/setup/ColdStartComposer').then((module) => ({
    default: module.ColdStartComposer,
  })),
)

// dnd-kit is interaction infrastructure, not first-paint UI. A post-paint load
// makes the provider ready for the first drag, while pointer or keyboard intent
// can start the same import sooner. The live panel deck stays outside the async
// provider and never remounts when it arrives.
const loadWorkspaceTabDrag = () => import('./workspace-tab-drag')
type WorkspaceTabDragModule = Awaited<ReturnType<typeof loadWorkspaceTabDrag>>
type LoadWorkspaceTabDrag = () => Promise<WorkspaceTabDragModule>

const pointerSnapshot = (event: PointerEvent): TabDragPointerEventSnapshot => ({
  pointerId: event.pointerId,
  pointerType: event.pointerType,
  isPrimary: event.isPrimary,
  button: event.button,
  buttons: event.buttons,
  clientX: event.clientX,
  clientY: event.clientY,
  ctrlKey: event.ctrlKey,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  metaKey: event.metaKey,
})

const passedTabDragThreshold = (
  start: TabDragPointerEventSnapshot,
  current: TabDragPointerEventSnapshot,
): boolean => Math.hypot(current.clientX - start.clientX, current.clientY - start.clientY) >= 5

const keyboardSnapshot = (event: KeyboardEvent): TabDragKeyboardEventSnapshot => ({
  key: event.key,
  code: event.code,
  ctrlKey: event.ctrlKey,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  metaKey: event.metaKey,
  repeat: event.repeat,
})

// A tab in the strip is either an agent/shell session or an open file editor. Both
// are first-class VIEWS (POD-710): the strip renders the current workspace's
// focused pane, not "every session in the mission". A running session with no tab
// is not in the strip — it lives in the flight deck, which is where sessions
// actually live. Closing a tab closes the view and never touches the session.
type WTab = DeckTab

const tabName = (t: WTab): string =>
  t.kind === 'file' ? (t.file.path.split('/').pop() ?? t.file.path) : ''

/** Smallest pane a drag may leave behind, in px — below this a pane is a sliver
 *  the operator has to fish for to get back. */
const MIN_PANE_PX = 160
/** Keyboard resize step, as a fraction of the split node. */
const RESIZE_STEP = 0.02
/** Keyboard resize floor when there is no measured box to convert px against. */
const MIN_PANE_FRACTION = 0.12

export function Workspace({
  loadDragRuntime = loadWorkspaceTabDrag,
}: {
  loadDragRuntime?: LoadWorkspaceTabDrag
} = {}): JSX.Element {
  const {
    sessions,
    selectedWorktree,
    paneA,
    fileTabs,
    closeFileTab,
    markSessionRead,
    repos,
    selectedIssueId,
    dockShells,
    workspaces,
    workspaceKey,
    openSessionTab,
    promoteWorkspaceTab,
    activateWorkspaceTab,
    closeWorkspaceTab,
    moveWorkspaceTab,
    splitWorkspacePane,
    closeWorkspacePane,
    focusWorkspacePane,
    resizeWorkspaceSplit,
  } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      selectedWorktree: s.selectedWorktree,
      paneA: s.paneA,
      fileTabs: s.fileTabs,
      closeFileTab: s.closeFileTab,
      markSessionRead: s.markSessionRead,
      repos: s.repos,
      selectedIssueId: s.selectedIssueId,
      dockShells: s.dockShells,
      workspaces: s.workspaces,
      // The engine's own resolver, not a second spelling of it (POD-710).
      workspaceKey: s.workspaceKey(),
      openSessionTab: s.openSessionTab,
      promoteWorkspaceTab: s.promoteWorkspaceTab,
      activateWorkspaceTab: s.activateWorkspaceTab,
      closeWorkspaceTab: s.closeWorkspaceTab,
      moveWorkspaceTab: s.moveWorkspaceTab,
      splitWorkspacePane: s.splitWorkspacePane,
      closeWorkspacePane: s.closeWorkspacePane,
      focusWorkspacePane: s.focusWorkspacePane,
      resizeWorkspaceSplit: s.resizeWorkspaceSplit,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { focusedIssueId, setFocusedIssueId } = useOperatorFocus()
  // The tab being dragged, for the overlay and for mounting the drop zones only
  // while a drag is in flight.
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [DragRuntime, setDragRuntime] =
    useState<ComponentType<WorkspaceTabDragRuntimeProps> | null>(null)
  const dragRuntimeRequested = useRef(false)
  const dragFocusToRestore = useRef<string | null>(null)
  const pendingDragActivation = useRef<
    | {
        kind: 'pointer'
        tabId: string
        start: TabDragPointerEventSnapshot
        latestMove: TabDragPointerEventSnapshot | null
        end: TabDragPointerEventSnapshot | null
        dragThresholdCrossed: boolean
      }
    | { kind: 'keyboard'; tabId: string; events: TabDragKeyboardEventSnapshot[] }
    | null
  >(null)
  const clearPendingDragListeners = useRef<(() => void) | null>(null)
  const clearColdDragClickListener = useRef<(() => void) | null>(null)
  const coldDragClickTimer = useRef<number | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)
  // Sizes being dragged on a pane divider, held locally until the pointer is
  // released — the same shape as the shell's ResizableColumn, which tracks the
  // width in React and persists once on pointerup rather than writing storage
  // on every frame.
  const [dragSizes, setDragSizes] = useState<{ path: number[]; sizes: number[] } | null>(null)
  const preloadDragRuntime = useCallback(
    (focusedTabId?: string): void => {
      if (focusedTabId) dragFocusToRestore.current = focusedTabId
      if (dragRuntimeRequested.current) return
      dragRuntimeRequested.current = true
      void loadDragRuntime().then((module) => {
        setDragRuntime(() => module.WorkspaceTabDragRuntime)
      })
    },
    [loadDragRuntime],
  )

  const clearColdDragClickSuppression = useCallback((): void => {
    if (coldDragClickTimer.current !== null) {
      window.clearTimeout(coldDragClickTimer.current)
      coldDragClickTimer.current = null
    }
    clearColdDragClickListener.current?.()
    clearColdDragClickListener.current = null
  }, [])

  const deferColdDragClickCleanup = useCallback((): void => {
    if (!clearColdDragClickListener.current || coldDragClickTimer.current !== null) return
    coldDragClickTimer.current = window.setTimeout(clearColdDragClickSuppression, 0)
  }, [clearColdDragClickSuppression])

  const suppressNextColdDragClick = useCallback(
    (tabId: string): void => {
      if (clearColdDragClickListener.current) return
      const ownerDocument = workspaceRef.current?.ownerDocument
      if (!ownerDocument) return
      const suppressClick = (click: MouseEvent): void => {
        const target = click.target
        const clickedTab =
          target instanceof Element
            ? target.closest<HTMLElement>('[data-tab-drag-id]')?.dataset.tabDragId
            : undefined
        if (clickedTab !== tabId) return
        click.preventDefault()
        click.stopPropagation()
        clearColdDragClickSuppression()
      }
      ownerDocument.addEventListener('click', suppressClick, true)
      clearColdDragClickListener.current = () =>
        ownerDocument.removeEventListener('click', suppressClick, true)
    },
    [clearColdDragClickSuppression],
  )

  const clearPendingDragActivation = useCallback((): void => {
    clearPendingDragListeners.current?.()
    clearPendingDragListeners.current = null
    pendingDragActivation.current = null
    clearColdDragClickSuppression()
  }, [clearColdDragClickSuppression])

  useEffect(() => clearPendingDragActivation, [clearPendingDragActivation])

  // The plain strip is keyboard-focusable while its runtime is loading. If the
  // provider's arrival replaces that focused node, put focus back on the same
  // tab so Space and the arrow keys work without another trip through the tab
  // order.
  const restoreDragFocus = useCallback((): void => {
    const tabId = dragFocusToRestore.current
    if (!tabId) return
    dragFocusToRestore.current = null
    const current = document.activeElement
    if (current instanceof HTMLElement) {
      if (current.dataset.tabDragId === tabId && current.isConnected) return
      if (current !== document.body && current.isConnected) return
    }
    const replacement = [
      ...(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-tab-drag-id]') ?? []),
    ].find((candidate) => candidate.dataset.tabDragId === tabId)
    replacement?.focus()
  }, [])

  const captureColdPointerActivation = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (DragRuntime || !event.isPrimary || event.button !== 0) return
      const target = event.target
      const tabNode =
        target instanceof Element ? target.closest<HTMLElement>('[data-tab-drag-id]') : null
      const tabId = tabNode?.dataset.tabDragId
      if (!tabId) return

      clearPendingDragActivation()
      const pending: {
        kind: 'pointer'
        tabId: string
        start: TabDragPointerEventSnapshot
        latestMove: TabDragPointerEventSnapshot | null
        end: TabDragPointerEventSnapshot | null
        dragThresholdCrossed: boolean
      } = {
        kind: 'pointer' as const,
        tabId,
        start: pointerSnapshot(event.nativeEvent),
        latestMove: null,
        end: null,
        dragThresholdCrossed: false,
      }
      pendingDragActivation.current = pending
      const onMove = (move: PointerEvent): void => {
        if (move.pointerId !== pending.start.pointerId) return
        pending.latestMove = pointerSnapshot(move)
        if (
          !pending.dragThresholdCrossed &&
          passedTabDragThreshold(pending.start, pending.latestMove)
        ) {
          pending.dragThresholdCrossed = true
          suppressNextColdDragClick(tabId)
        }
      }
      const stopListening = (): void => {
        clearPendingDragListeners.current?.()
        clearPendingDragListeners.current = null
      }
      const onUp = (end: PointerEvent): void => {
        if (end.pointerId !== pending.start.pointerId) return
        const finish = pointerSnapshot(end)
        const latest = pending.latestMove ?? finish
        if (!pending.dragThresholdCrossed && passedTabDragThreshold(pending.start, latest)) {
          pending.dragThresholdCrossed = true
          suppressNextColdDragClick(tabId)
        }
        if (!pending.dragThresholdCrossed) {
          clearPendingDragActivation()
          return
        }
        pending.latestMove = latest
        pending.end = finish
        stopListening()
        deferColdDragClickCleanup()
      }
      const onCancel = (cancel: PointerEvent): void => {
        if (cancel.pointerId === pending.start.pointerId) clearPendingDragActivation()
      }
      document.addEventListener('pointermove', onMove, true)
      document.addEventListener('pointerup', onUp, true)
      document.addEventListener('pointercancel', onCancel, true)
      clearPendingDragListeners.current = () => {
        document.removeEventListener('pointermove', onMove, true)
        document.removeEventListener('pointerup', onUp, true)
        document.removeEventListener('pointercancel', onCancel, true)
      }
      preloadDragRuntime()
    },
    [
      DragRuntime,
      clearPendingDragActivation,
      deferColdDragClickCleanup,
      preloadDragRuntime,
      suppressNextColdDragClick,
    ],
  )

  const captureColdKeyboardActivation = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (DragRuntime || (event.code !== 'Space' && event.code !== 'Enter')) return
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.matches('[data-tab-drag-id]')) return
      const tabId = target.dataset.tabDragId
      if (!tabId) return

      event.preventDefault()
      clearPendingDragActivation()
      dragFocusToRestore.current = tabId
      const pending = {
        kind: 'keyboard' as const,
        tabId,
        events: [keyboardSnapshot(event.nativeEvent)],
      }
      pendingDragActivation.current = pending
      const onKeyDown = (followup: KeyboardEvent): void => {
        if (followup.code === 'Escape') {
          followup.preventDefault()
          clearPendingDragActivation()
          return
        }
        if (
          !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'Tab'].includes(
            followup.code,
          )
        )
          return
        followup.preventDefault()
        pending.events.push(keyboardSnapshot(followup))
      }
      document.addEventListener('keydown', onKeyDown, true)
      clearPendingDragListeners.current = () =>
        document.removeEventListener('keydown', onKeyDown, true)
      preloadDragRuntime(tabId)
    },
    [DragRuntime, clearPendingDragActivation, preloadDragRuntime],
  )

  const preparePendingDragActivation = useCallback((): PendingTabDragActivation | null => {
    restoreDragFocus()
    const pending = pendingDragActivation.current
    if (!pending) return null
    const target = [
      ...(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-tab-drag-id]') ?? []),
    ].find((candidate) => candidate.dataset.tabDragId === pending.tabId)
    clearPendingDragListeners.current?.()
    clearPendingDragListeners.current = null
    pendingDragActivation.current = null
    if (!target) return null
    return pending.kind === 'pointer'
      ? {
          kind: 'pointer',
          target,
          start: pending.start,
          latestMove: pending.latestMove,
          end: pending.end,
        }
      : { kind: 'keyboard', target, events: pending.events }
  }, [restoreDragFocus])

  const allWorktrees = reposToViews(repos).flatMap((r) => r.worktrees)
  const worktree: WorktreeView | undefined = allWorktrees.find((w) => w.path === selectedWorktree)

  // Issue-keyed workspace (issue-as-workspace, unified layout only): when an
  // issue row is selected, the tab strip shows that task's workspace instead of
  // a worktree's. The mission scan survives only to answer "which issue is in
  // view" (the + menu's spawn target, the file-tab scope, the coordinator
  // badge) — it no longer decides tab MEMBERSHIP.
  const missionIssue = selectedIssueId
    ? issues.find((i) => i.id === selectedIssueId && !i.archived && !i.deletedAt)
    : undefined
  const missionRoot = missionIssue ? missionRootFor(issues, missionIssue.id) : undefined
  const missionIds = missionRoot
    ? missionIssueIds(issues, missionRoot.id, sessions)
    : new Set<string>()
  const missionIssues = missionRoot
    ? issues.filter((candidate) => missionIds.has(candidate.id))
    : []
  const issue =
    (focusedIssueId && missionIds.has(focusedIssueId)
      ? issues.find((candidate) => candidate.id === focusedIssueId)
      : undefined) ?? missionRoot
  const issueWorktree = issue?.worktreePath
    ? allWorktrees.find((w) => w.path === issue.worktreePath)
    : undefined
  // Where the "+" menu spawns inside an issue workspace: the issue's worktree,
  // or the repo's primary (main) worktree for worktree-less issues.
  const panelTarget: WorktreeView | undefined = issue
    ? (issueWorktree ??
      allWorktrees.find((w) => w.repoPath === issue.repoPath && w.isMain) ?? {
        path: issue.repoPath,
        repoPath: issue.repoPath,
        isMain: true,
      })
    : worktree

  // The workspace layout is the source of truth for what has a tab (POD-710),
  // read at the key the ENGINE resolves — `s.workspaceKey()`. This used to be
  // recomputed here from `useReplicaIssues()` while the engine used `st.issues`.
  // The walk is identical, so the two agreed whenever the collections did — but
  // `optimism.ts` documents that during the additive cutover a legacy issue row
  // can arrive before its normalized projection, and for that interval one side
  // said `mission:<root>` and the other `issue:<id>`: an empty tab strip over a
  // panel rendering normally. One resolver, no second spelling.
  const layout = workspaces[workspaceKey] ?? emptyWorkspace(workspaceKey)
  const previewTabId = layout.previewTabId

  // Splitting is ordinary now (POD-1649): every leaf of the tree is on screen,
  // so the geometry is the layout's own root. There is no second, narrower
  // notion of "shown" for anything downstream to disagree with.
  const shownLayout = dragSizes ? resizeSplit(layout, dragSizes.path, dragSizes.sizes) : layout
  const geometry = deckGeometry(shownLayout.root)
  const visiblePanes: Pane[] = geometry.panes.flatMap((rect) => {
    const found = layout.panes[rect.paneId]
    return found ? [found] : []
  })
  // The pane every pane-less gesture lands in: the focused one when it is on
  // screen, else the first — `focusedPaneId` can outlive the pane it names.
  const activePane =
    visiblePanes.find((candidate) => candidate.id === layout.focusedPaneId) ?? visiblePanes[0]
  const focusPane = (paneId: string): void => {
    if (paneId !== layout.focusedPaneId) focusWorkspacePane(paneId)
  }

  // Dock-owned shells (#23) live in the right dock's Shell panel, never as tabs.
  const dockShellIds = new Set<string>(Object.values(dockShells))
  const sessionById = new Map<string, SessionMeta>(sessions.map((s) => [s.sessionId, s]))
  const fileById = new Map<string, FileTab>(fileTabs.map((f) => [f.id, f]))
  const resolveTab = (id: string): WTab | undefined => {
    const session = sessionById.get(id)
    if (session) {
      return dockShellIds.has(id) ? undefined : { id, kind: 'session', session }
    }
    const file = fileById.get(id)
    return file ? { id, kind: 'file', file } : undefined
  }
  const resolveAll = (ids: readonly string[]): WTab[] =>
    ids.map(resolveTab).filter((t): t is WTab => !!t)

  // Every pane carries its own strip, editor-style; the deck mounts every pane's
  // tabs — including panes the flag is hiding — so nothing remounts when a split
  // appears, moves or goes away.
  const deckTabs = resolveAll(allTabIds(layout))
  const byId = new Map(deckTabs.map((t) => [t.id, t]))
  const activeTabId = activePane?.activeTabId ?? null

  // Start fetching after the workspace has painted, but before an operator can
  // reasonably press, touch, or keyboard-pick up its first tab. Pointer and
  // focus intent remain as the faster path when they reach the strip first.
  // Empty panes stay cold because there is nothing in them to drag.
  useEffect(() => {
    if (deckTabs.length === 0 || dragRuntimeRequested.current) return
    const timer = window.setTimeout(preloadDragRuntime, 0)
    return () => window.clearTimeout(timer)
  }, [deckTabs.length, preloadDragRuntime])
  // M6: the issue's designated coordinator sessions, resolved once for every
  // pane's strip rather than per tab.
  const coordinatorIds = new Set(
    deckTabs
      .filter(
        (t) =>
          t.kind === 'session' &&
          missionIssues.some((candidate) => isCoordinatorSession(candidate, t.session.sessionId)),
      )
      .map((t) => t.id),
  )

  // Warm panels span issue switches [POD-782] [spec:SP-0b2e]: issues are the MAIN
  // way to own sessions, so the deck of mounted panels is the current workspace's
  // tabs UNION the most-recently-viewed sessions from previously-viewed issues,
  // kept warm up to an LRU cap (8 desktop / 3 mobile). Feeding the warm set the
  // GLOBAL live-session universe (not just this workspace's tabs) is what lets a
  // foreign session stay in the recency list across the switch instead of being
  // pruned the moment its issue leaves the strip — so re-selecting it is a warm
  // reveal (chat:cache-hit), not a cold panel:mount. Sorted so incidental
  // reordering of the session list doesn't churn the warm-recompute key. Archived
  // and dock-owned sessions are excluded (a killed session simply leaves
  // `sessions`), so an archived/killed foreign panel drops from the deck.
  const knownSessionIds = new Set(
    sessions.filter((s) => !s.archived && !dockShellIds.has(s.sessionId)).map((s) => s.sessionId),
  )
  const warmUniverse = [...knownSessionIds].sort()
  const activeIds = visiblePanes
    .map((candidate) => candidate.activeTabId)
    .filter((x): x is SessionId => x != null)
  const warm = useWarmSet(warmUniverse, activeIds)

  // Closing a tab closes the VIEW. A session tab's session is never killed,
  // archived or otherwise touched — that lives in the flight deck now. A file
  // tab goes through `closeFileTab`, which drops the `fileTabs` record AND the
  // layout entry: leaving the record behind would keep the file listed as open
  // with nothing rendering it.
  const closeTab = (tabId: string): void => {
    if (fileById.has(tabId)) closeFileTab(tabId)
    else closeWorkspaceTab(tabId)
  }

  // Cmd+W in the desktop shell [POD-93]: the native menu owns the accelerator (the
  // webview never sees the keypress), so the shell's "Close Tab" item evals this
  // hook instead. Returning false is reserved for no tab / an unmounted Workspace.
  // Re-registered every render so it always sees the current pane; no deps array
  // on purpose.
  useEffect(() => {
    const g = globalThis as { __PODIUM_CLOSE_TAB__?: () => boolean }
    g.__PODIUM_CLOSE_TAB__ = () =>
      closeActiveWorkspaceTab(activeTabId && byId.has(activeTabId) ? activeTabId : null, closeTab)
    return () => {
      delete g.__PODIUM_CLOSE_TAB__
    }
  })

  /**
   * NO MISSION AND NOTHING OPEN IS THE COLD DECK (POD-1153).
   *
   * `selectedMissionRoot` is the flight deck's own question — "is there a
   * mission on screen at all?" — so both columns go cold together. A selection
   * left pointing at an ARCHIVED task, or at an empty draft vessel, is not a
   * mission: the sidebar shows nothing selected for either, and this column
   * used to answer with "Nothing open in this pane" anyway.
   *
   * That empty state is a DEAD END here, which is why it cannot be the
   * fallback: its ＋ menu spawns INTO an issue, and there is no issue to attach
   * to, so every route out of it is closed. The composer is the honest surface
   * — it makes the task the pane would need.
   *
   * TABS WIN OVER THE COMPOSER: a pane with something in it is not cold,
   * whatever the selection says. A vessel that is FILLING never reaches here
   * anyway — the spawn inserts its session optimistically, so the draft
   * resolves as a mission from the click rather than from the broadcast.
   */
  const missionOnScreen = selectedMissionRoot(issues, sessions, selectedIssueId)
  if (!missionOnScreen && deckTabs.length === 0) {
    const hasAnyTask = issues.some((candidate) => !candidate.deletedAt)
    return (
      <section className="native-agents-pane relative" data-testid="workspace-cold-deck">
        <div className="workspace-sheet relative flex min-h-0 flex-1">
          <Suspense fallback={null}>
            <ColdStartComposer first={!hasAnyTask} />
          </Suspense>
        </div>
      </section>
    )
  }

  if (!worktree && !issue) {
    // The selected path is no longer a live worktree, but it may still own
    // sessions whose directory was removed out from under them (an orphaned
    // session — e.g. a deleted git worktree). Rather than a dead-end "Select a
    // worktree." screen, surface the orphan so its transcript stays readable:
    // AgentPanel renders it read-only and its exited banner explains the worktree
    // is gone. Only fall back to the placeholder when there's genuinely nothing
    // to show (no selection, or the path has no sessions).
    const orphan = orphanSessionFor({ selectedWorktree, sessions, paneA })
    if (orphan)
      return (
        <div className="flex min-w-0 flex-1">
          <AgentPanel sessionId={orphan.sessionId} active />
        </div>
      )
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/70">
        Select a worktree.
      </div>
    )
  }

  /**
   * WHERE A DRAGGED TAB LANDS.
   *
   * One DndContext spans every pane, so a tab can leave the strip it started in.
   * Four kinds of target, in the order they are resolved:
   *   `split:<axis>:<pane>` — the trailing edge of a pane's body: split it and
   *      put the tab in the new pane.
   *   `strip:<pane>` / `pane:<pane>` — anywhere else in a pane: append.
   *   another tab — land at that tab's index, in ITS pane (a same-pane drop is
   *      the plain reorder this always did; pane order IS the tab order now, so
   *      the server-side `tabOrders` overlay has no job here).
   */
  const onDragEnd = (activeId: string, overId: string | null): void => {
    deferColdDragClickCleanup()
    setDragTabId(null)
    if (!overId) return
    const drop = resolveTabDrop(layout, activeId, overId)
    if (!drop) return
    if (drop.kind === 'split') splitWorkspacePane(drop.paneId, drop.axis, { tabId: drop.tabId })
    else if (drop.kind === 'move') moveWorkspaceTab(drop.tabId, drop.paneId, drop.index)
    else activateWorkspaceTab(drop.tabId)
  }

  const dragTab = dragTabId === null ? undefined : byId.get(dragTabId)

  // A divider drag previews locally and lands in the LAYOUT — split proportions
  // are part of how the operator arranged this task, so they travel with its
  // workspace instead of into a storage key of their own.
  const onSeamResize = (path: readonly number[], sizes: readonly number[], commit: boolean) => {
    if (!commit) {
      setDragSizes({ path: [...path], sizes: [...sizes] })
      return
    }
    setDragSizes(null)
    resizeWorkspaceSplit(path, sizes)
  }

  const selectTab = (t: WTab): void => {
    // Switch-latency trace [POD-701]: a tab click that changes the focused
    // session starts a trace at the gesture (no-op switches — clicking the
    // already-active tab — are skipped).
    if (t.kind === 'session' && t.id !== activeTabId) {
      beginSwitch({
        sessionId: asSessionId(t.id),
        issueId: t.session.issueId ?? issue?.id ?? null,
      })
    }
    // Opening a session tab marks it read (#126) so the sidebar row's unread
    // emphasis clears in step with what's on screen.
    if (t.kind === 'session') void markSessionRead(asSessionId(t.id))
    // Selection contract: a session tab click highlights its OWNING issue. A
    // session with no issue belongs to the mission itself, so focus falls back
    // to the root. A file tab is not a session identity and only moves focus
    // when it names an issue.
    if (t.kind === 'session') {
      setFocusedIssueId(t.session.issueId ?? missionRoot?.id ?? null)
    } else if (t.kind === 'file' && t.file.issueId) {
      setFocusedIssueId(t.file.issueId)
    }
    // Selecting a tab is a reading gesture — it activates, it never promotes.
    // Promotion is input into the session (usePreviewPromotion) or a
    // double-click in the flight deck.
    activateWorkspaceTab(t.id)
  }

  const renderChrome = (drag?: TabDragComponents): JSX.Element => (
    <>
      {geometry.panes.map((rect) => {
        const paneOf = layout.panes[rect.paneId]
        if (!paneOf) return null
        return (
          <PaneChrome
            key={rect.paneId}
            rect={rect}
            pane={paneOf}
            tabs={resolveAll(paneOf.tabs)}
            otherTabs={deckTabs.filter((t) => !paneOf.tabs.includes(t.id))}
            focused={paneOf.id === activePane?.id}
            alone={geometry.panes.length === 1}
            previewTabId={previewTabId}
            coordinatorIds={coordinatorIds}
            drag={drag}
            onDragIntent={preloadDragRuntime}
            onColdPointerDown={captureColdPointerActivation}
            onColdKeyDown={captureColdKeyboardActivation}
            // biome-ignore lint/style/noNonNullAssertion: the early return above guarantees worktree or issue (which makes panelTarget defined)
            panelTarget={panelTarget!}
            issueId={issue?.id}
            onFocus={() => focusPane(paneOf.id)}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onKeepOpen={promoteWorkspaceTab}
            onSplit={(axis, tabId) => splitWorkspacePane(paneOf.id, axis, { tabId })}
            onClosePane={() => closeWorkspacePane(paneOf.id)}
            onOpened={(sid) => openSessionTab(sid, { permanent: true, paneId: paneOf.id })}
            onAdopt={(id) => {
              // Filling an empty pane marks the session read too (#126).
              if (byId.get(id)?.kind === 'session') void markSessionRead(asSessionId(id))
              moveWorkspaceTab(id, paneOf.id, 0)
            }}
          />
        )
      })}
      {/* Drop targets exist only DURING a drag: a pane's body is not a click
        target the rest of the time, and mounting them permanently would put
        four inert overlays over every terminal. */}
      {drag &&
        dragTabId !== null &&
        geometry.panes.map((rect) => <PaneDropZones key={rect.paneId} rect={rect} drag={drag} />)}
    </>
  )

  return (
    // THE SHEET (POD-725). The stage used to be a column like the others; it is
    // now a sheet lying in a gutter, with the app ground visible around it and
    // the window's one real drop shadow under it. The pane region, its strips
    // and its seams are unchanged — the sheet only clips and lifts them.
    <section ref={workspaceRef} className="native-agents-pane relative">
      <div className="workspace-sheet relative">
        {/* THE DECK BOX. Panes are rectangles inside it rather than nested
          containers, so the panel list underneath stays FLAT (see panel-deck.ts):
          splitting, resizing and dragging a tab across panes are pure layout
          changes and never reparent — so never remount — a live terminal. */}
        <div className="relative min-h-0 min-w-0 flex-1">
          {/* The panel deck [POD-782] [spec:SP-0b2e]: the current workspace's tabs
              plus the foreign warm sessions carried over from previously-viewed
              issues — all mounted, only the on-screen panes visible (display:none
              for the rest). */}
          <PanelDeck
            items={composeDeck({
              tabs: deckTabs,
              warm,
              knownSessionIds,
              panes: visiblePanes,
            })}
            panes={geometry.panes}
            onCloseFile={closeTab}
            previewTabId={previewTabId}
            onPromote={promoteWorkspaceTab}
            onFocusPane={focusPane}
            focusedTabId={activeTabId}
          />
          {DragRuntime ? (
            <DragRuntime
              overlay={dragTab ? <TabGhost tab={dragTab} /> : null}
              onDragStart={setDragTabId}
              onDragEnd={onDragEnd}
              onDragCancel={() => {
                clearColdDragClickSuppression()
                setDragTabId(null)
              }}
              onReady={preparePendingDragActivation}
            >
              {renderChrome}
            </DragRuntime>
          ) : (
            renderChrome()
          )}
          {geometry.seams.map((seam) => (
            <PaneSeam key={seam.id} seam={seam} onResize={onSeamResize} />
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * One pane's chrome: its own tab strip, and the empty state under it.
 *
 * Editor-style means every pane carries its OWN strip (VS Code, Zed, Cursor all
 * do) — which is also what makes "drag this tab into that pane" a gesture with
 * somewhere to land. The chrome is an overlay over the pane's box and is
 * `pointer-events-none` except where it draws something, so the panel beneath it
 * keeps every click the strip does not want.
 */
function PaneChrome({
  rect,
  pane,
  tabs,
  otherTabs,
  focused,
  alone,
  previewTabId,
  coordinatorIds,
  drag,
  onDragIntent,
  onColdPointerDown,
  onColdKeyDown,
  panelTarget,
  issueId,
  onFocus,
  onSelectTab,
  onCloseTab,
  onKeepOpen,
  onSplit,
  onClosePane,
  onOpened,
  onAdopt,
}: {
  rect: PaneRect
  pane: Pane
  tabs: WTab[]
  /** Tabs living in OTHER panes — what an empty pane can adopt. */
  otherTabs: WTab[]
  focused: boolean
  /** The only pane on screen: no pane-level close. It no longer decides which
   *  empty state shows — `otherTabs` does (POD-1058). */
  alone: boolean
  previewTabId: string | null
  coordinatorIds: ReadonlySet<string>
  drag?: TabDragComponents
  onDragIntent: (focusedTabId?: string) => void
  onColdPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onColdKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  panelTarget: WorktreeView
  issueId?: IssueId
  onFocus: () => void
  onSelectTab: (tab: WTab) => void
  onCloseTab: (tabId: string) => void
  onKeepOpen: (tabId: string) => void
  onSplit: (axis: SplitAxis, tabId?: string) => void
  onClosePane: () => void
  onOpened: (sessionId: SessionId) => void
  onAdopt: (tabId: string) => void
}): JSX.Element {
  const activeTabId = pane.activeTabId
  const hasPanel = activeTabId !== null && tabs.some((t) => t.id === activeTabId)
  const tabItems = tabs.map((t) =>
    drag ? (
      <drag.Item key={t.id} id={t.id}>
        {(bindings) => (
          <SortableTab
            tab={t}
            active={t.id === activeTabId}
            preview={t.id === previewTabId}
            coordinator={coordinatorIds.has(t.id)}
            drag={bindings}
            onSelect={() => onSelectTab(t)}
            onClose={() => onCloseTab(t.id)}
            onCloseOthers={() => {
              for (const other of tabs) if (other.id !== t.id) onCloseTab(other.id)
            }}
            onCloseAll={() => {
              for (const other of tabs) onCloseTab(other.id)
            }}
            onKeepOpen={() => onKeepOpen(t.id)}
            onSplit={(axis: SplitAxis) => onSplit(axis, t.id)}
          />
        )}
      </drag.Item>
    ) : (
      <SortableTab
        key={t.id}
        tab={t}
        active={t.id === activeTabId}
        preview={t.id === previewTabId}
        coordinator={coordinatorIds.has(t.id)}
        onSelect={() => onSelectTab(t)}
        onClose={() => onCloseTab(t.id)}
        onCloseOthers={() => {
          for (const other of tabs) if (other.id !== t.id) onCloseTab(other.id)
        }}
        onCloseAll={() => {
          for (const other of tabs) onCloseTab(other.id)
        }}
        onKeepOpen={() => onKeepOpen(t.id)}
        onSplit={(axis: SplitAxis) => onSplit(axis, t.id)}
      />
    ),
  )
  const strip = (setNodeRef?: (node: HTMLElement | null) => void, isOver = false): JSX.Element => (
    <div className="pointer-events-none absolute flex flex-col" style={paneBoxStyle(rect)}>
      {/* Tab strip (POD-725): 38px, the tabstrip surface, a soft bottom hairline,
          and tabs that are PILLS centred in it rather than browser tabs stretched
          to its bottom edge. The strip is no longer a tinted band — with the
          stage now a white sheet, an issue wash across its top edge was the
          loudest thing in the pane and it said nothing the active tab's own ring
          and dot do not already say.
          The tint survives at a dose you read as tone rather than colour, because
          it is still how a SPLIT says which pane is live (The Carved Rule: said
          in tone, not with a ring around it) — and it still lifts when a pane is
          about to receive a dragged tab, which is the one moment it must shout.
          The doses are BOUNDED BY THE SHEET (POD-748). Every mix here walks the
          strip toward a lighter colour, and on the Dark Ink ramp there are only
          three levels between the strip (#202228) and the sheet it is cut into
          (#23262d) — so the old focused dose put the strip at #25272d, ABOVE the
          card, and the recess read as a raised band. Focus is worth at most the
          two levels that keep it under the sheet; an unfocused strip is the
          mock's own flat value. The drag target is the one state allowed out. */}
      <div
        ref={setNodeRef}
        data-testid="native-tab-strip"
        data-pane={pane.id}
        data-focused={focused ? 'true' : undefined}
        data-drag-runtime={drag ? 'ready' : undefined}
        onPointerEnter={() => onDragIntent()}
        onPointerDownCapture={(event) => {
          onFocus()
          onColdPointerDown(event)
          onDragIntent()
        }}
        onPointerMoveCapture={() => onDragIntent()}
        onFocusCapture={(event) => {
          const target = event.target
          onDragIntent(
            target instanceof HTMLElement && target.matches('[data-session]')
              ? target.dataset.session
              : undefined,
          )
        }}
        onKeyDownCapture={onColdKeyDown}
        className={cn(
          'pointer-events-auto relative flex h-[38px] flex-none items-center gap-[4px] border-b border-hairline-soft issue-base-tabstrip px-[10px]',
          isOver
            ? 'issue-mix-24 issue-mix-slate-18'
            : focused
              ? 'issue-mix-3 issue-mix-slate-2'
              : 'issue-mix-1 issue-mix-slate-0',
        )}
      >
        {drag ? (
          <drag.List items={tabs.map((t) => t.id)}>
            <div className="flex min-w-0 flex-1 items-stretch gap-[2px] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {tabs.length === 0 && <GhostTabs />}
              {tabItems}
            </div>
          </drag.List>
        ) : (
          <div className="flex min-w-0 flex-1 items-stretch gap-[2px] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tabs.length === 0 && <GhostTabs />}
            {tabItems}
          </div>
        )}
        <div className="flex flex-none items-center gap-0.5">
          {/* NewPanelMenu owns the portalled dropdown; the strip supplies a
              quiet inline "+" trigger (untinted per §2.2). Split keeps its
              behaviour as an equally quiet neutral glyph (Q4). */}
          <NewPanelMenu
            worktree={panelTarget}
            issueId={issueId}
            // A session the operator deliberately started is not a peek —
            // it opens permanent, in THIS pane.
            onOpened={onOpened}
            trigger={
              <button
                data-pressable
                type="button"
                className="flex size-[26px] cursor-pointer items-center justify-center rounded-lg text-text-dim hover:bg-secondary hover:text-foreground"
                title="New panel"
                aria-label="New panel"
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            }
          />
          <button
            data-pressable
            type="button"
            className="flex size-[26px] cursor-pointer items-center justify-center rounded-lg text-text-dim hover:bg-secondary hover:text-foreground"
            title="Split Right"
            aria-label="Split Right"
            onClick={() => onSplit('row')}
          >
            <Columns2 size={13} aria-hidden="true" />
          </button>
          {/* A pane emptied by closing its tabs collapses on its own; this is the
              way out of a pane that never had one — the empty half a split of a
              single-tab pane leaves behind. */}
          {!alone && (
            <button
              data-pressable
              type="button"
              className="flex size-[26px] cursor-pointer items-center justify-center rounded-lg text-text-dim hover:bg-secondary hover:text-foreground"
              title="Close pane"
              aria-label="Close pane"
              onClick={onClosePane}
            >
              <PanelRightClose size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {!hasPanel && (
        <div className="pointer-events-auto flex min-h-0 flex-1">
          {/* WHAT THERE IS TO ADOPT decides this, not whether the pane is alone
              (POD-1058). When another pane holds tabs, the picker is strictly
              the better state — it offers the actual views. `alone` got the
              same answer right in the common case and wrong in one: the empty
              half of a split whose sibling had nothing in it drew an empty
              picker, a heading over no choices. */}
          {otherTabs.length === 0 ? (
            <Empty worktree={panelTarget} issueId={issueId} onOpened={onOpened} />
          ) : (
            <PanePicker tabs={otherTabs} onPick={onAdopt} />
          )}
        </div>
      )}
    </div>
  )
  return drag ? (
    <drag.Strip id={stripDropId(pane.id)}>
      {({ setNodeRef, isOver }) => strip(setNodeRef, isOver)}
    </drag.Strip>
  ) : (
    strip()
  )
}

/**
 * A pane divider. Same idiom as the shell's `ResizableColumn`: a thin grab strip
 * over a hairline seam, dragged with pointer capture, keyboard-operable, and
 * persisted once on release. What differs is where the size LIVES — a fraction
 * inside the workspace layout rather than a pixel width under a storage key,
 * because this proportion belongs to the task's arrangement and travels with it.
 */
function PaneSeam({
  seam,
  onResize,
}: {
  seam: SplitSeam
  onResize: (path: readonly number[], sizes: readonly number[], commit: boolean) => void
}): JSX.Element {
  const row = seam.axis === 'row'
  const latest = useRef<number[]>([...seam.sizes])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    // The deck box is this handle's parent — every pane rect is a fraction of it.
    const deck = handle.parentElement?.getBoundingClientRect()
    const extent = row ? seam.width : seam.height
    if (!deck || extent <= 0) return
    handle.setPointerCapture(e.pointerId)
    const spanPx = (row ? deck.width : deck.height) * extent
    const min = spanPx > 0 ? Math.min(0.4, MIN_PANE_PX / spanPx) : MIN_PANE_FRACTION
    const move = (ev: PointerEvent): void => {
      const along = row
        ? (ev.clientX - deck.left) / deck.width
        : (ev.clientY - deck.top) / deck.height
      const local = (along - (row ? seam.left : seam.top)) / extent
      latest.current = resizedSizes(seam.sizes, seam.index, local, min)
      onResize(seam.path, latest.current, false)
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      onResize(seam.path, latest.current, true)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
    handle.addEventListener('pointercancel', up, { once: true })
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const back = row ? 'ArrowLeft' : 'ArrowUp'
    const forward = row ? 'ArrowRight' : 'ArrowDown'
    if (e.key !== back && e.key !== forward) return
    e.preventDefault()
    const at = seam.sizes.slice(0, seam.index + 1).reduce((sum, size) => sum + size, 0)
    const step = e.key === forward ? RESIZE_STEP : -RESIZE_STEP
    onResize(seam.path, resizedSizes(seam.sizes, seam.index, at + step, MIN_PANE_FRACTION), true)
  }

  const share = seam.sizes[seam.index] ?? 0
  return (
    // biome-ignore lint/a11y/useSemanticElements: the divider is an interactive, keyboard-operable separator
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      data-seam={seam.id}
      className={cn(
        'group absolute z-10',
        row
          ? 'w-[7px] -translate-x-1/2 cursor-col-resize'
          : 'h-[7px] -translate-y-1/2 cursor-row-resize',
      )}
      style={seamBoxStyle(seam)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      {/* The seam at rest is a hairline, like every other join in the shell; the
          grab area around it is invisible until the pointer is on it. */}
      <div
        className={cn(
          'absolute bg-border transition-colors group-hover:bg-primary/50 group-active:bg-primary/70 group-focus-visible:bg-primary/50',
          row
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
        )}
      />
    </div>
  )
}

/**
 * Where a dragged tab may land inside one pane: anywhere in its body to join it,
 * or the trailing edge to split the pane and take the new half.
 *
 * Trailing edges only. `splitPane` puts the new pane AFTER the one it splits, so
 * a leading-edge zone would promise a placement the model does not have; two
 * honest zones beat four where half of them land somewhere else.
 */
function PaneDropZones({ rect, drag }: { rect: PaneRect; drag: TabDragComponents }): JSX.Element {
  return (
    <div className="pointer-events-none absolute" style={panelBoxStyle(rect)}>
      <DropZone id={paneDropId(rect.paneId)} className="absolute inset-0" drag={drag} />
      <DropZone
        id={splitDropId('row', rect.paneId)}
        className="absolute inset-y-0 right-0 w-[26%]"
        drag={drag}
      />
      <DropZone
        id={splitDropId('column', rect.paneId)}
        className="absolute inset-x-0 bottom-0 h-[26%]"
        drag={drag}
      />
    </div>
  )
}

function DropZone({
  id,
  className,
  drag,
}: {
  id: string
  className: string
  drag: TabDragComponents
}): JSX.Element {
  return (
    <drag.DropZone id={id}>
      {({ setNodeRef, isOver }) => (
        <div
          ref={setNodeRef}
          data-dropzone={id}
          data-over={isOver ? 'true' : undefined}
          className={cn(className, isOver && 'bg-primary/15 outline outline-1 outline-primary/45')}
        />
      )}
    </drag.DropZone>
  )
}

/** The dragged tab, rendered over everything so it survives leaving its strip. */
function TabGhost({ tab }: { tab: WTab }): JSX.Element {
  return (
    <div className="pointer-events-none flex max-w-[220px] cursor-grabbing items-center gap-1.5 rounded-[3px] border border-border-strong bg-chip px-2 py-1 text-[10.5px] whitespace-nowrap text-text-strong shadow-popover">
      {tab.kind === 'session' ? (
        <WorkerLabel session={tab.session} />
      ) : (
        <>
          <FileText size={12} aria-hidden="true" className="flex-none text-text-dim" />
          <span className="truncate">{tabName(tab)}</span>
        </>
      )}
    </div>
  )
}

function SortableTab({
  tab,
  active,
  preview,
  coordinator = false,
  drag,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onKeepOpen,
  onSplit,
}: {
  tab: WTab
  active: boolean
  /** The workspace's ONE temporary tab — italic, replaced by the next preview. */
  preview: boolean
  /** M6: issue's designated coordinator session — elevated marker on the tab. */
  coordinator?: boolean
  drag?: TabDragItemBindings
  onSelect: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
  onKeepOpen: () => void
  onSplit?: (axis: SplitAxis) => void
}): JSX.Element {
  const renameSession = useStoreSelector((s) => s.renameSession)
  const [editing, setEditing] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const isDragging = drag?.isDragging === true
  const node = useRef<HTMLDivElement | null>(null)
  // The strip scrolls when crowded — keep the active tab visible in it.
  useEffect(() => {
    if (active) node.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  // POINTING AT A TAB POINTS AT ITS ROW. The deck draws the same session, and
  // finding it there by name is work the pointer can do for free.
  const isSessionTab = tab.kind === 'session'
  // dnd-kit takes pointer capture for the drag, so the leave that would clear
  // the highlight never arrives — the row would stay lit after the drop. Both
  // the drag and the unmount (a closed tab, a switched issue) end the hover
  // the same way: by id, so a tab that is no longer the pointed-at one is a
  // no-op rather than a blank.
  useEffect(() => {
    if (isSessionTab && isDragging) clearHoveredSession(tab.id)
  }, [isSessionTab, isDragging, tab.id])
  useEffect(() => {
    if (!isSessionTab) return
    return () => clearHoveredSession(tab.id)
  }, [isSessionTab, tab.id])
  // The 7×7px leading square is the ISSUE colour (via --issue / .tab-issue-dot)
  // — full strength on the active tab, faded on the rest. The agent's identity
  // accent left the tab (spec G2); agent identity lives in the panel header
  // chip. `parked` keeps the hibernated grayed/italic label hook.
  const issueDot = (
    <span
      className={cn(
        'dot tab-issue-dot size-[7px] min-w-[7px]',
        tab.kind === 'session' && tab.session.status === 'hibernated' && 'parked',
        !active && 'opacity-55',
      )}
      aria-hidden="true"
    />
  )
  return (
    <div
      ref={(el) => {
        node.current = el
        drag?.setNodeRef(el)
      }}
      data-tab-drag-id={tab.id}
      // A PILL, NOT A BROWSER TAB (POD-725). Tabs used to share the strip evenly
      // and shrink as more opened, which is the file-editor idiom — but an editor
      // tab is a filename and ours is a running agent with a state dot, a name
      // and sometimes a badge, and stretched-to-fit made three sessions look like
      // a segmented control over one document. Content-sized pills scroll instead
      // of shrinking, so the tenth tab is reachable rather than illegible.
      // The ACTIVE one is raised onto the card with a real (small) drop and a 1px
      // issue ring — the one place inside the sheet that borrows the sheet's own
      // floating idiom, because it is the one thing you are looking at.
      className={cn(
        'group relative flex h-[28px] max-w-[220px] flex-none items-center rounded-lg',
        // The overlay carries the tab while it is dragged; what stays behind is
        // the gap it will come back to.
        isDragging ? 'cursor-grabbing opacity-30' : 'cursor-grab',
        active ? 'native-tab-active bg-card' : isDragging ? 'issue-mix-10' : 'hover:issue-mix-8',
      )}
      data-session={tab.id}
      data-preview={preview ? 'true' : undefined}
      title={tab.kind === 'file' ? tab.file.path : undefined}
      // Mouse and pen only: a tap is not a hover, and on touch the highlight
      // would arrive with the selection it already made redundant.
      onPointerEnter={
        isSessionTab
          ? (e) => {
              if (e.pointerType !== 'touch' && !isDragging) setHoveredSession(tab.id)
            }
          : undefined
      }
      onPointerLeave={isSessionTab ? () => clearHoveredSession(tab.id) : undefined}
      style={drag?.style}
      {...(drag?.attributes ?? {
        role: 'button',
        tabIndex: 0,
        'aria-disabled': false,
        'aria-roledescription': 'sortable',
      })}
      {...drag?.listeners}
    >
      {tab.kind === 'session' && editing ? (
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1">
          {issueDot}
          <SessionNameEditor
            value={sessionDisplayName(tab.session)}
            onCommit={(name) => {
              void renameSession(asSessionId(tab.id), name)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        </span>
      ) : (
        <button
          data-pressable
          type="button"
          className={cn(
            'inline-flex h-full min-w-0 flex-1 cursor-[inherit] items-center gap-[7px] rounded-lg px-[11px] text-[11.5px] whitespace-nowrap',
            active ? 'font-semibold text-text-strong' : 'text-text-dim',
            // A temporary tab reads italic and nothing else — no badge, no second
            // colour. It is the same tab, held lightly.
            preview && 'italic',
          )}
          onClick={onSelect}
          // Renaming a session is view-adjacent and already muscle memory.
          onDoubleClick={tab.kind === 'session' ? () => setEditing(true) : undefined}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenuAnchor({ x: e.clientX, y: e.clientY })
          }}
        >
          {tab.kind === 'session' ? (
            <>
              {issueDot} <WorkerLabel session={tab.session} />
              {coordinator && (
                <span
                  className="flex-none rounded border border-sky-500/50 bg-sky-500/15 px-1 shell-type-micro font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400"
                  data-testid="coordinator-tab-badge"
                  title="Coordinator session — drives this issue"
                >
                  coord
                </span>
              )}
              {/* Status grammar (§2.8): braille spinner while working, still
                  amber dot when waiting on you, nothing otherwise. Semantic
                  colours — never the issue colour. */}
              <AgentStatusGlyph session={tab.session} variant="tab" />
            </>
          ) : (
            <>
              <FileText
                size={12}
                aria-hidden="true"
                className="flex-none text-(--issue-muted-bright)"
              />
              <span className="truncate">{tabName(tab)}</span>
            </>
          )}
        </button>
      )}
      {/* Every tab closes (POD-710) — a tab is a view, and closing it never
          touches the session behind it. */}
      <button
        data-pressable
        type="button"
        className={cn(
          'h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-(--issue-muted) hover:text-destructive',
          active ? 'inline-flex' : 'hidden group-hover:inline-flex',
        )}
        title="Close tab"
        aria-label="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <X size={11} aria-hidden="true" />
      </button>
      {menuAnchor && (
        <TabContextMenu
          anchor={menuAnchor}
          preview={preview}
          {...(tab.kind === 'session' ? { sessionId: tab.session.sessionId } : {})}
          onClose={() => setMenuAnchor(null)}
          onCloseTab={onClose}
          onCloseOthers={onCloseOthers}
          onCloseAll={onCloseAll}
          onKeepOpen={onKeepOpen}
          onSplit={onSplit}
        />
      )}
    </div>
  )
}

/**
 * The tab's own right-click menu — VIEW-scoped only (POD-710). Session lifecycle
 * (kill / archive / snooze / hibernate / handoff) moved to the flight deck, where
 * sessions actually live; a menu on the tab that could kill an agent is exactly
 * the tab/session conflation this work undoes.
 *
 * POD-1077 KEPT THAT BOUNDARY AND PAID ITS COST. The rule was right and the cost
 * was real: an operator looking straight at an agent had no route from the tab to
 * the row that governs it, so the menu read as a dead end. The answer is
 * "Reveal in flight deck" — one item that MOVES you to where the verbs are,
 * rather than copying the verbs onto a surface that must not have them. It is
 * also why the first item now says "Close tab" and not "Close": the session menu
 * spells its terminal action "Delete session…", and the two menus must not both
 * offer a bare "Close" meaning very different things.
 */
function TabContextMenu({
  anchor,
  preview,
  sessionId,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onKeepOpen,
  onSplit,
}: {
  anchor: ContextMenuAnchor
  preview: boolean
  /** Set when this tab is a SESSION view — file tabs have no row to reveal. */
  sessionId?: SessionId
  onClose: () => void
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
  onKeepOpen: () => void
  onSplit?: (axis: SplitAxis) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<ContextMenuAnchor>(anchor)

  // Clamp into the viewport once the menu has measured its real size, so a
  // right-click near the bottom/right edge doesn't open a clipped menu.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)),
    })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const run = (fn: () => void): void => {
    fn()
    onClose()
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Tab actions"
      className={`fixed z-[60] min-w-[168px] ${MENU_PANEL}`}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        data-pressable
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        onClick={() => run(onCloseTab)}
      >
        <X size={14} aria-hidden="true" /> Close tab
      </button>
      <button
        data-pressable
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        onClick={() => run(onCloseOthers)}
      >
        Close Others
      </button>
      <button
        data-pressable
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        onClick={() => run(onCloseAll)}
      >
        Close All
      </button>
      {/* "Keep Open" states what it does to a temporary tab; on a tab that is
          already permanent it is inert rather than absent, so the menu doesn't
          change shape under the cursor. */}
      <button
        data-pressable
        type="button"
        role="menuitem"
        disabled={!preview}
        className={preview ? MENU_ITEM : MENU_ITEM_DISABLED}
        onClick={() => run(onKeepOpen)}
      >
        Keep Open
      </button>
      {onSplit && (
        <>
          <hr className={MENU_RULE} />
          <button
            data-pressable
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => run(() => onSplit('row'))}
          >
            <SquareSplitHorizontal size={14} aria-hidden="true" /> Split Right
          </button>
          <button
            data-pressable
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => run(() => onSplit('column'))}
          >
            <SquareSplitVertical size={14} aria-hidden="true" /> Split Down
          </button>
        </>
      )}
      {/* The one item on this menu that is ABOUT the session rather than the
          view — and it is navigation, not lifecycle, which is exactly why it is
          allowed here. Under its own rule, last, so the view actions above it
          stay one uninterrupted group. */}
      {sessionId && (
        <>
          <hr className={MENU_RULE} />
          <button
            data-pressable
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() =>
              run(() =>
                window.dispatchEvent(new CustomEvent(REVEAL_IN_DECK_EVENT, { detail: sessionId })),
              )
            }
          >
            <Crosshair size={14} aria-hidden="true" /> Reveal in flight deck
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}

/**
 * NOTHING OPEN IN THIS PANE (POD-1058, "ADE Empty States" 2d/2e).
 *
 * A TAB IS A VIEW, and the copy has to say so. Closing a tab closes the view
 * and never touches the session — sessions live in the flight deck — so an
 * empty state that promised "open a tab to start an agent" would be describing
 * a different product. It is also NOT a first-run state: this is equally the
 * moment after closing the last tab, so it must never read like onboarding.
 *
 * THE BUTTON IS THE ＋ MENU, not a hidden tab factory. It is labelled "New
 * panel" because that is the menu's own title and because it OPENS a menu
 * rather than silently creating something; the footnote lists what the menu
 * offers, which is the honest version of a promise this button cannot keep on
 * its own. No shortcut is claimed — nothing in the code registers one for it,
 * and a made-up chord on an empty state is worse than none.
 */
function Empty({
  worktree,
  issueId,
  onOpened,
}: {
  worktree: WorktreeView
  issueId?: IssueId
  onOpened: (sessionId: SessionId) => void
}): JSX.Element {
  return (
    <div className="m-auto flex max-w-[430px] flex-col items-center px-12 text-center">
      <p className="text-[21px] leading-[1.3] font-semibold tracking-[-.02em] text-text-strong">
        Nothing open in this pane
      </p>
      <p className="mt-2.5 text-[13.5px] leading-[1.6] text-muted-foreground text-pretty">
        A tab is a view — one agent at work, or one file. Pick an agent in the flight deck to watch
        it here, or open a new panel.
      </p>
      <NewPanelMenu
        worktree={worktree}
        issueId={issueId}
        onOpened={onOpened}
        trigger={
          <button
            data-pressable
            type="button"
            data-testid="pane-empty-new-panel"
            className="mt-5 flex h-[34px] cursor-pointer items-center justify-center gap-2 rounded-[9px] bg-attention/12 px-[15px] text-[12.5px] font-semibold text-attention ring-1 ring-attention/30 ring-inset hover:bg-attention/20"
          >
            <Plus size={16} aria-hidden="true" />
            New panel
          </button>
        }
      />
      <p className="mt-3 font-mono text-[11px] text-text-faint">agent · shell · file</p>
    </div>
  )
}

/**
 * Two dead tabs where the real ones appear.
 *
 * The first wears a status dot and the second a file glyph, because the one
 * thing the strip has to teach is that BOTH kinds live in it — a strip ghosted
 * with two identical pills would teach the shape and lose the point.
 *
 * No fade here, unlike every other ghost in the shell: these are 28px tall in a
 * 38px strip, so a vertical mask would read as a rendering bug rather than as a
 * hint. The strip's own short height already stops them being mistaken for a
 * list that continues.
 */
function GhostTabs(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none flex select-none items-center gap-1"
      data-testid="pane-ghost-tabs"
    >
      <span className="flex h-[28px] items-center gap-2.5 rounded-lg border border-dashed border-(--ghost-1) px-3">
        <span className="size-[7px] rounded-full bg-(--success) opacity-40" />
        <span className="h-[7px] w-[70px] rounded-[4px] bg-(--ghost-2)" />
      </span>
      <span className="flex h-[28px] items-center gap-2.5 rounded-lg px-3 opacity-55">
        <span className="h-[11px] w-[9px] rounded-[2px] bg-(--ghost-3)" />
        <span className="h-[7px] w-[52px] rounded-[4px] bg-(--ghost-3)" />
      </span>
    </div>
  )
}

function PanePicker({ tabs, onPick }: { tabs: WTab[]; onPick: (id: string) => void }): JSX.Element {
  return (
    <div className="m-auto flex flex-col items-center gap-2 text-[13px] text-muted-foreground/70">
      <div>Pick a panel for this pane:</div>
      {tabs.map((t) => (
        <Button key={t.id} variant="secondary" size="sm" onClick={() => onPick(t.id)}>
          {t.kind === 'session' ? <WorkerLabel session={t.session} /> : tabName(t)}
        </Button>
      ))}
    </div>
  )
}
