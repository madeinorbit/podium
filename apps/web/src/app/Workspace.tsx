import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { beginSwitch } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import type { WorktreeView } from '@podium/client-core/viewmodels'
import {
  allTabIds,
  emptyWorkspace,
  focusedPane as focusedPaneOf,
  isCoordinatorSession,
  missionIssueIds,
  missionRootFor,
  orphanSessionFor,
  reposToViews,
  type SplitAxis,
  workspaceKeyFor,
} from '@podium/client-core/viewmodels'
import { asSessionId, type SessionId, type SessionMeta } from '@podium/model'
import {
  Columns2,
  FileText,
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { AgentPanel } from '@/features/terminal/AgentPanel'
import { useWarmSet } from '@/features/terminal/use-warm-set'
import { MENU_ITEM, MENU_ITEM_DISABLED, MENU_PANEL, MENU_RULE } from '@/lib/menu-surface'
import { AgentStatusGlyph } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/SessionContextMenu'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { NewPanelMenu } from './NewPanelMenu'
import { useOperatorFocus } from './operator-focus'
import { PanelDeck } from './PanelDeck'
import { composeDeck, type DeckTab } from './panel-deck'
import { type FileTab, useReplicaIssues, useStoreSelector } from './store'
import { closeActiveWorkspaceTab } from './workspace-close'

// A tab in the strip is either an agent/shell session or an open file editor. Both
// are first-class VIEWS (POD-710): the strip renders the current workspace's
// focused pane, not "every session in the mission". A running session with no tab
// is not in the strip — it lives in the flight deck, which is where sessions
// actually live. Closing a tab closes the view and never touches the session.
type WTab = DeckTab

const tabName = (t: WTab): string =>
  t.kind === 'file' ? (t.file.path.split('/').pop() ?? t.file.path) : ''

export function Workspace(): JSX.Element {
  const {
    sessions,
    selectedWorktree,
    paneA,
    paneB,
    setPane,
    split,
    toggleSplit,
    fileTabs,
    closeFileTab,
    markSessionRead,
    repos,
    selectedIssueId,
    dockShells,
    workspaces,
    openSessionTab,
    promoteWorkspaceTab,
    activateWorkspaceTab,
    closeWorkspaceTab,
    moveWorkspaceTab,
    splitWorkspacePane,
  } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      selectedWorktree: s.selectedWorktree,
      paneA: s.paneA,
      paneB: s.paneB,
      setPane: s.setPane,
      split: s.split,
      toggleSplit: s.toggleSplit,
      fileTabs: s.fileTabs,
      closeFileTab: s.closeFileTab,
      markSessionRead: s.markSessionRead,
      repos: s.repos,
      selectedIssueId: s.selectedIssueId,
      dockShells: s.dockShells,
      workspaces: s.workspaces,
      openSessionTab: s.openSessionTab,
      promoteWorkspaceTab: s.promoteWorkspaceTab,
      activateWorkspaceTab: s.activateWorkspaceTab,
      closeWorkspaceTab: s.closeWorkspaceTab,
      moveWorkspaceTab: s.moveWorkspaceTab,
      splitWorkspacePane: s.splitWorkspacePane,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { focusedIssueId, setFocusedIssueId } = useOperatorFocus()
  const tabSplittingEnabled = useFeature('tab-splitting')
  const visibleSplit = tabSplittingEnabled && split
  // A small drag threshold keeps plain clicks (select/close) working — the drag
  // only starts once the pointer has actually moved.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

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

  // The workspace layout is the source of truth for what has a tab (POD-710).
  // The key must be the one `workspaceKeyForState` computes engine-side — the
  // mission root wins over the selected sub-issue, because a mission shares ONE
  // tab strip. A view that spelled the key differently would read a workspace
  // nobody writes.
  const workspaceKey = workspaceKeyFor({
    missionRootId: missionRoot?.id ?? null,
    issueId: selectedIssueId,
    worktreePath: selectedWorktree,
  })
  const layout = workspaces[workspaceKey] ?? emptyWorkspace(workspaceKey)
  const pane = focusedPaneOf(layout)
  const previewTabId = layout.previewTabId

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

  // The strip is the FOCUSED pane; the deck mounts every pane's tabs so a split's
  // second pane keeps its panels alive.
  const stripTabs = resolveAll(pane.tabs)
  const deckTabs = resolveAll(allTabIds(layout))
  const byId = new Map(deckTabs.map((t) => [t.id, t]))
  const activeTabId = pane.activeTabId

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
  const activeIds = [paneA, visibleSplit ? paneB : null].filter((x): x is SessionId => x != null)
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

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const toIndex = stripTabs.findIndex((t) => t.id === String(over.id))
    if (toIndex < 0) return
    // Pane order IS the tab order now (POD-710) — the server-side `tabOrders`
    // overlay no longer has a job in the strip.
    moveWorkspaceTab(String(active.id), pane.id, toIndex)
  }

  return (
    <section className="native-agents-pane relative flex min-w-0 flex-1 flex-col">
      {/* Tab strip (native-pane spec §2.2): 34px, issue-tinted over the tabstrip
          surface, tinted bottom hairline; tabs are stretched to the strip's
          bottom edge (pt only, no pb). */}
      <div
        data-testid="native-tab-strip"
        className="relative flex h-(--section-bar-h) flex-none items-stretch gap-[2px] border-b issue-hairline-50 issue-hairline-slate-45 issue-mix-18 issue-mix-slate-14 issue-base-tabstrip px-[6px] pt-[4px]"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          // Tabs may only slide along the strip — a free y-axis would drag the
          // tab out of the row and vertically scroll the overflow container.
          modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={stripTabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex min-w-0 flex-1 items-stretch gap-[2px] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {stripTabs.map((t) => (
                <SortableTab
                  key={t.id}
                  tab={t}
                  active={t.id === activeTabId}
                  preview={t.id === previewTabId}
                  splitting={tabSplittingEnabled}
                  coordinator={
                    t.kind === 'session' &&
                    missionIssues.some((missionIssue) =>
                      isCoordinatorSession(missionIssue, t.session.sessionId),
                    )
                  }
                  onSelect={() => {
                    // Switch-latency trace [POD-701]: a tab click that changes the
                    // focused session starts a trace at the gesture (no-op switches
                    // — clicking the already-active tab — are skipped).
                    if (t.kind === 'session' && t.id !== activeTabId) {
                      beginSwitch({
                        sessionId: asSessionId(t.id),
                        issueId: t.session.issueId ?? issue?.id ?? null,
                      })
                    }
                    // Opening a session tab marks it read (#126) so the sidebar
                    // row's unread emphasis clears in step with what's on screen.
                    if (t.kind === 'session') void markSessionRead(asSessionId(t.id))
                    // Selection contract: a session tab click highlights its
                    // OWNING issue. A session with no issue belongs to the
                    // mission itself, so focus falls back to the root. A file tab
                    // is not a session identity and only moves focus when it
                    // names an issue.
                    if (t.kind === 'session') {
                      setFocusedIssueId(t.session.issueId ?? missionRoot?.id ?? null)
                    } else if (t.kind === 'file' && t.file.issueId) {
                      setFocusedIssueId(t.file.issueId)
                    }
                    // Selecting a tab is a reading gesture — it activates, it
                    // never promotes. Promotion is input into the session
                    // (usePreviewPromotion) or a double-click in the flight deck.
                    activateWorkspaceTab(t.id)
                  }}
                  onClose={() => closeTab(t.id)}
                  onCloseOthers={() => {
                    for (const other of stripTabs) if (other.id !== t.id) closeTab(other.id)
                  }}
                  onCloseAll={() => {
                    for (const other of stripTabs) closeTab(other.id)
                  }}
                  onKeepOpen={() => promoteWorkspaceTab(t.id)}
                  onSplit={(axis: SplitAxis) => splitWorkspacePane(pane.id, axis, { tabId: t.id })}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <div className="flex flex-none items-center gap-0.5">
          {/* NewPanelMenu owns the portalled dropdown; the strip supplies a
              quiet inline "+" trigger (untinted per §2.2). Split keeps its
              behaviour as an equally quiet neutral glyph (Q4). */}
          <NewPanelMenu
            // biome-ignore lint/style/noNonNullAssertion: the early return above guarantees worktree or issue (which makes panelTarget defined)
            worktree={panelTarget!}
            issueId={issue?.id}
            // A session the operator deliberately started is not a peek —
            // it opens permanent.
            onOpened={(sid) => openSessionTab(sid, { permanent: true })}
            trigger={
              <button
                data-pressable
                type="button"
                className="flex cursor-pointer items-center self-stretch rounded px-[9px] text-[13px] text-text-dim hover:text-foreground"
                title="New panel"
                aria-label="New panel"
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            }
          />
          {tabSplittingEnabled && (
            <button
              data-pressable
              type="button"
              className="flex cursor-pointer items-center self-stretch rounded px-[7px] text-text-dim hover:text-foreground"
              title="Split"
              aria-label="Split"
              onClick={toggleSplit}
            >
              <Columns2 size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {/* The panel deck [POD-782] [spec:SP-0b2e]: the current workspace's tabs
          plus the foreign warm sessions carried over from previously-viewed
          issues — all mounted, only the active pane(s) visible (display:none for
          the rest). Rendered as one flat keyed list (PanelDeck) so a session that
          moves between the tab group and the foreign group keeps its component
          identity — no remount, so re-selecting it is a warm reveal. `order`
          places the split panes A|B regardless of DOM order. */}
      <div className="flex min-h-0 flex-1">
        <PanelDeck
          items={composeDeck({
            tabs: deckTabs,
            warm,
            knownSessionIds,
            paneA,
            paneB,
            split: visibleSplit,
          })}
          split={visibleSplit}
          onCloseFile={closeTab}
          previewTabId={previewTabId}
          onPromote={promoteWorkspaceTab}
        />
        {!paneA && (
          <div className="flex min-w-0 flex-1" style={{ order: 0 }}>
            <Empty />
          </div>
        )}
        {visibleSplit && !paneB && (
          <div className="flex min-w-0 flex-1 border-l border-border" style={{ order: 1 }}>
            <PanePicker
              tabs={deckTabs}
              onPick={(id) => {
                // Opening a session into the split pane marks it read too (#126).
                if (byId.get(id)?.kind === 'session') void markSessionRead(asSessionId(id))
                setPane('B', asSessionId(id))
              }}
            />
          </div>
        )}
      </div>
    </section>
  )
}

function SortableTab({
  tab,
  active,
  preview,
  splitting,
  coordinator = false,
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
  /** `tab-splitting` is on, so the menu offers Split Right / Split Down. */
  splitting: boolean
  /** M6: issue's designated coordinator session — elevated marker on the tab. */
  coordinator?: boolean
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  })
  const node = useRef<HTMLDivElement | null>(null)
  // The strip scrolls when crowded — keep the active tab visible in it.
  useEffect(() => {
    if (active) node.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
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
        setNodeRef(el)
      }}
      // Chrome-like tab sizing: tabs share the strip evenly, shrink as more open, stop at
      // a minimum (then the strip scrolls), and never balloon when alone. `group` drives
      // the hover-reveal of the close control. Active tab (spec §2.2): tinted fill,
      // tinted hairline (no bottom edge), the 2px issue-colour inset top line.
      className={cn(
        'group relative flex max-w-[200px] min-w-[110px] flex-[1_1_180px] items-center rounded-t-[3px] border border-b-0 border-transparent px-0.5',
        isDragging ? 'z-[2] cursor-grabbing opacity-90' : 'cursor-grab',
        active
          ? 'native-tab-active issue-hairline-50 issue-hairline-slate-45 issue-mix-28 issue-mix-slate-22'
          : isDragging
            ? 'issue-mix-14'
            : 'hover:issue-mix-14',
      )}
      data-session={tab.id}
      data-preview={preview ? 'true' : undefined}
      title={tab.kind === 'file' ? tab.file.path : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
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
            'inline-flex min-w-0 flex-1 cursor-[inherit] items-center gap-1.5 rounded-none px-2 py-1 text-[10.5px] whitespace-nowrap',
            active ? 'font-semibold text-(--issue-text)' : 'text-(--issue-muted-bright)',
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
                  className="flex-none rounded border border-sky-500/50 bg-sky-500/15 px-1 text-[8.5px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400"
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
          splitting={splitting}
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
 */
function TabContextMenu({
  anchor,
  preview,
  splitting,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onKeepOpen,
  onSplit,
}: {
  anchor: ContextMenuAnchor
  preview: boolean
  splitting: boolean
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
        <X size={14} aria-hidden="true" /> Close
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
      {splitting && onSplit && (
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
    </div>,
    document.body,
  )
}

function Empty(): JSX.Element {
  return (
    <div className="m-auto text-[13px] text-muted-foreground/70">
      No tab open — pick a session in the flight deck, or use + to start one.
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
