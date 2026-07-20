import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { beginSwitch } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import { Archive, Columns2, FileText, Pin, Plus, X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AgentPanel } from '@/features/terminal/AgentPanel'
import { useWarmSet } from '@/features/terminal/use-warm-set'
import {
  archivedSessionsForIssue,
  archivedSessionsForWorktreePath,
  isCoordinatorSession,
  orderTabs,
  orphanSessionFor,
  reposToViews,
  sessionsForIssueNav,
  sessionsForWorktree,
} from '@/lib/derive'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { AgentStatusGlyph } from '@/lib/motion'
import { type ContextMenuAnchor, SessionContextMenu } from '@/lib/SessionContextMenu'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { NewPanelMenu } from './NewPanelMenu'
import { PanelDeck } from './PanelDeck'
import { composeDeck, type DeckTab } from './panel-deck'
import { useStoreSelector } from './store'
import type { WorktreeView } from './types'
import { fileTabsForWorkspace } from './workspace-tabs'

// A tab in the strip is either an agent/shell session or an open file editor. Both are
// first-class: same strip, same drag/select/close behaviour. paneA/paneB hold a tab id
// (sessionId for sessions, the FileTab.id `file:…` for files). The deck of mounted
// panels (PanelDeck) spans issue switches; the tab STRIP still shows only these.
type WTab = DeckTab

const tabName = (t: WTab): string =>
  t.kind === 'file' ? (t.file.path.split('/').pop() ?? t.file.path) : ''

export function Workspace(): JSX.Element {
  const {
    sessions,
    pins,
    setPinned,
    tabOrders,
    setTabOrder,
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
    issues,
    dockShells,
  } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      pins: s.pins,
      setPinned: s.setPinned,
      tabOrders: s.tabOrders,
      setTabOrder: s.setTabOrder,
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
      issues: s.issues,
      dockShells: s.dockShells,
    }),
    shallowEqual,
  )
  const tabSplittingEnabled = useFeature('tab-splitting')
  const visibleSplit = tabSplittingEnabled && split
  // Closing a session tab routes through the active-session guard (#115) so a
  // working agent prompts for confirmation; file tabs close immediately.
  const { guardedKill } = useSessionGuard()
  // A session created via the "+" menu (or restored from localStorage on reload)
  // lands in `paneA` before the server's broadcast adds it to the tab list. Without
  // this, the keep-pane-valid effect sees an unknown paneA and bounces it to tab 0.
  const justOpened = useRef<string | null>(paneA)
  // Same hold for a restored/just-opened pane B (the split's second pane): don't
  // clear it before the store knows the session, or a reload with split=true would
  // wipe pane B back to the picker before sessions arrive.
  const justOpenedB = useRef<string | null>(paneB)
  // A small drag threshold keeps plain clicks (select/pin/close) working — the
  // drag only starts once the pointer has actually moved.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  // Archived member sessions are hidden from the strip until the user reveals them
  // (the "N archived" control at the end of the strip reopens them as tabs).
  const [showArchived, setShowArchived] = useState(false)

  const allWorktrees = reposToViews(repos).flatMap((r) => r.worktrees)
  const allWorktreePaths = allWorktrees.map((w) => w.path)
  const worktree: WorktreeView | undefined = allWorktrees.find((w) => w.path === selectedWorktree)

  // Issue-keyed workspace (issue-as-workspace, unified layout only): when an
  // issue row is selected, the tab strip shows the issue's sessions (explicit
  // issueId first-class + cwd-contained legacy) instead of a worktree's.
  const issue = selectedIssueId
    ? issues.find((i) => i.id === selectedIssueId && !i.archived && !i.deletedAt)
    : undefined
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

  // Unified, ordered tab list (sessions + open files). Default order is pin-aware
  // sessions then files; a manual drag order (persisted per worktree — or per
  // issue under an `issue:<id>` key — may include file ids) is applied on top.
  // File ids that no longer exist (after reload) are dropped.
  // Dock-owned shells (#23) live in the right dock's Shell panel, never as tabs.
  const dockShellIds = new Set(Object.values(dockShells))
  const liveSessionList = (
    issue
      ? sessionsForIssueNav(issue, sessions, allWorktreePaths, { includeShells: true })
      : worktree
        ? sessionsForWorktree(sessions, worktree.path, allWorktreePaths)
        : []
  ).filter((s) => !dockShellIds.has(s.sessionId))
  // Archived members of the viewed issue/worktree — kept out of the strip until
  // revealed, then appended so they reopen as (readable) tabs.
  const archivedMembers = (
    issue
      ? archivedSessionsForIssue(issue, sessions, allWorktreePaths)
      : worktree
        ? archivedSessionsForWorktreePath(sessions, worktree.path, allWorktreePaths)
        : []
  ).filter((s) => !dockShellIds.has(s.sessionId))
  const sessionList = showArchived ? [...liveSessionList, ...archivedMembers] : liveSessionList
  const fileList = fileTabsForWorkspace(fileTabs, { issue, worktreePath: worktree?.path })
  const orderKey = issue ? `issue:${issue.id}` : worktree?.path
  const byId = new Map<string, WTab>()
  for (const s of sessionList)
    byId.set(s.sessionId, { id: s.sessionId, kind: 'session', session: s })
  for (const f of fileList) byId.set(f.id, { id: f.id, kind: 'file', file: f })
  const baseIds = [
    ...orderTabs(sessionList, undefined, pins, issue?.coordinatorSessionId).map((s) => s.sessionId),
    ...fileList.map((f) => f.id),
  ]
  const manual = orderKey ? tabOrders[orderKey] : undefined
  let orderedIds =
    manual && manual.length
      ? [...manual.filter((id) => byId.has(id)), ...baseIds.filter((id) => !manual.includes(id))]
      : baseIds
  // M6: keep the designated coordinator first even under a saved drag order so
  // "who is driving" stays unambiguous in the strip.
  const coordId = issue?.coordinatorSessionId
  if (coordId && orderedIds.includes(coordId)) {
    orderedIds = [coordId, ...orderedIds.filter((id) => id !== coordId)]
  }
  const allTabs: WTab[] = orderedIds.map((id) => byId.get(id)).filter((t): t is WTab => !!t)

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
  const activeIds = [paneA, visibleSplit ? paneB : null].filter((x): x is string => x != null)
  const warm = useWarmSet(warmUniverse, activeIds)

  // Keep pane A pointed at a valid tab.
  useEffect(() => {
    if (paneA && paneA !== justOpened.current && !sessions.some((s) => s.sessionId === paneA)) {
      justOpened.current = paneA
    }
    if (paneA && allTabs.some((t) => t.id === paneA)) {
      justOpened.current = null
      return
    }
    // Don't bounce away from a just-opened/restored pane that hasn't reached the store
    // yet; fall back only once it's known to be gone.
    if (paneA && justOpened.current === paneA && !sessions.some((s) => s.sessionId === paneA)) {
      return
    }
    // An orphaned session — paneA names a real, non-archived session whose
    // worktree was removed out from under it (so `worktree` is undefined and the
    // session is absent from allTabs, there being no worktree to list it under) —
    // is still a valid pane that the orphan branch below renders. Keep it instead
    // of bouncing to null. Scoped to `!worktree` so the archive-active-session
    // flow (worktree present) still falls through and re-points pane A.
    if (
      !worktree &&
      paneA &&
      sessions.some((s) => s.sessionId === paneA && s.cwd === selectedWorktree && !s.archived)
    ) {
      return
    }
    setPane('A', allTabs[0]?.id ?? null)
  }, [allTabs, paneA, setPane, sessions, selectedWorktree, worktree])

  // Keep pane B (the split's second pane) pointed at something valid. Unlike pane
  // A there's no fall-back target — a B that goes stale just clears to the picker —
  // but it gets the same just-opened/restored hold so a reload doesn't wipe it
  // before the session it names has reached the store.
  useEffect(() => {
    if (!paneB) return
    if (paneB !== justOpenedB.current && !sessions.some((s) => s.sessionId === paneB)) {
      justOpenedB.current = paneB
    }
    if (allTabs.some((t) => t.id === paneB)) {
      justOpenedB.current = null
      return
    }
    // Still holding a restored/just-opened pane the store hasn't broadcast yet.
    if (justOpenedB.current === paneB && !sessions.some((s) => s.sessionId === paneB)) return
    // Genuinely gone (or moved out of this worktree) — drop it back to the picker.
    setPane('B', null)
  }, [allTabs, paneB, setPane, sessions])

  // Cmd+W in the desktop shell [POD-93]: the native menu owns the accelerator (the
  // webview never sees the keypress), so the shell's "Close Tab" item evals this
  // hook instead. Closing the active tab mirrors the tab's own ✕ — sessions go
  // through the working-agent guard, files close immediately. Returning false
  // (no tab to close, or Workspace unmounted) lets the shell fall back to its
  // window-level close (hide). Re-registered every render so it always sees the
  // current pane; no deps array on purpose.
  useEffect(() => {
    const g = globalThis as { __PODIUM_CLOSE_TAB__?: () => boolean }
    g.__PODIUM_CLOSE_TAB__ = () => {
      const active = paneA ? byId.get(paneA) : undefined
      if (!active) return false
      if (active.kind === 'session') void guardedKill(active.id)
      else closeFileTab(active.id)
      return true
    }
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
    const ids = allTabs.map((t) => t.id)
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    if (orderKey) void setTabOrder(orderKey, next)
  }

  return (
    <section className="native-agents-pane relative flex min-w-0 flex-1 flex-col">
      {/* Tab strip (native-pane spec §2.2): 34px, issue-tinted over the tabstrip
          surface, tinted bottom hairline; tabs are stretched to the strip's
          bottom edge (pt only, no pb). */}
      <div
        data-testid="native-tab-strip"
        className="relative flex h-[34px] flex-none items-stretch gap-[2px] border-b issue-hairline-50 issue-hairline-slate-45 issue-mix-18 issue-mix-slate-14 issue-base-tabstrip px-[6px] pt-[4px]"
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
            items={allTabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex min-w-0 flex-1 items-stretch gap-[2px] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {allTabs.map((t) => (
                <SortableTab
                  key={t.id}
                  tab={t}
                  active={t.id === paneA}
                  pinned={t.kind === 'session' && pins.panels.includes(t.id)}
                  coordinator={
                    t.kind === 'session' &&
                    !!issue &&
                    isCoordinatorSession(issue, t.session.sessionId)
                  }
                  onSelect={() => {
                    // Switch-latency trace [POD-701]: a tab click that changes the
                    // focused session starts a trace at the gesture (no-op switches
                    // — clicking the already-active tab — are skipped).
                    if (t.kind === 'session' && t.id !== paneA) {
                      beginSwitch({ sessionId: t.id, issueId: issue?.id ?? null })
                    }
                    // Opening a session tab marks it read (#126) so the sidebar
                    // row's unread emphasis clears in step with what's on screen.
                    if (t.kind === 'session') void markSessionRead(t.id)
                    setPane('A', t.id)
                  }}
                  onTogglePin={
                    t.kind === 'session'
                      ? () => void setPinned('panel', t.id, !pins.panels.includes(t.id))
                      : undefined
                  }
                  onClose={() =>
                    t.kind === 'session' ? void guardedKill(t.id) : closeFileTab(t.id)
                  }
                />
              ))}
              {/* Reveal/hide archived member sessions as tabs — only shown when the
                  viewed issue/worktree actually has any. */}
              {archivedMembers.length > 0 && (
                <button
                  type="button"
                  className="flex flex-none cursor-pointer items-center gap-1 self-center rounded px-2 py-0.5 text-[10.5px] text-text-dim hover:text-(--issue-muted-bright)"
                  aria-pressed={showArchived}
                  title={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <Archive size={11} aria-hidden="true" />
                  {showArchived ? 'Hide archived' : `${archivedMembers.length} archived`}
                </button>
              )}
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
            onOpened={(sid) => {
              justOpened.current = sid
              setPane('A', sid)
            }}
            trigger={
              <button
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
            tabs: allTabs,
            warm,
            knownSessionIds,
            paneA,
            paneB,
            split: visibleSplit,
          })}
          split={visibleSplit}
          onCloseFile={closeFileTab}
        />
        {!paneA && (
          <div className="flex min-w-0 flex-1" style={{ order: 0 }}>
            <Empty />
          </div>
        )}
        {visibleSplit && !paneB && (
          <div className="flex min-w-0 flex-1 border-l border-border" style={{ order: 1 }}>
            <PanePicker
              tabs={allTabs}
              onPick={(id) => {
                // Opening a session into the split pane marks it read too (#126).
                if (byId.get(id)?.kind === 'session') void markSessionRead(id)
                setPane('B', id)
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
  pinned,
  coordinator = false,
  onSelect,
  onTogglePin,
  onClose,
}: {
  tab: WTab
  active: boolean
  pinned: boolean
  /** M6: issue's designated coordinator session — elevated marker on the tab. */
  coordinator?: boolean
  onSelect: () => void
  onTogglePin?: () => void
  onClose: () => void
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
      // the hover-reveal of the pin/close controls. Active tab (spec §2.2): tinted fill,
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
              void renameSession(tab.id, name)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        </span>
      ) : (
        <button
          type="button"
          className={cn(
            'inline-flex min-w-0 flex-1 cursor-[inherit] items-center gap-1.5 rounded-none px-2 py-1 text-[10.5px] whitespace-nowrap',
            active ? 'font-semibold text-(--issue-text)' : 'text-(--issue-muted-bright)',
          )}
          onClick={onSelect}
          onDoubleClick={tab.kind === 'session' ? () => setEditing(true) : undefined}
          onContextMenu={
            tab.kind === 'session'
              ? (e) => {
                  e.preventDefault()
                  setMenuAnchor({ x: e.clientX, y: e.clientY })
                }
              : undefined
          }
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
      {/* Pin (Q3): kept as a hover-reveal affordance, restyled to a quiet
          ctx-muted glyph; always visible while pinned. */}
      {tab.kind === 'session' && onTogglePin && (
        <button
          type="button"
          className={cn(
            'h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-(--issue-muted) hover:text-(--issue-text)',
            pinned ? 'inline-flex text-(--issue-text)' : 'hidden group-hover:inline-flex',
          )}
          aria-pressed={pinned}
          title={pinned ? 'Unpin panel' : 'Pin panel'}
          onClick={onTogglePin}
        >
          <Pin size={11} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className={cn(
          'h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-(--issue-muted) hover:text-destructive',
          active ? 'inline-flex' : 'hidden group-hover:inline-flex',
        )}
        title={tab.kind === 'session' ? 'Kill session' : 'Close file'}
        onClick={onClose}
      >
        <X size={11} aria-hidden="true" />
      </button>
      {tab.kind === 'session' && menuAnchor && (
        <SessionContextMenu
          session={tab.session}
          pinned={pinned}
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          onRename={() => {
            setMenuAnchor(null)
            setEditing(true)
          }}
        />
      )}
    </div>
  )
}

function Empty(): JSX.Element {
  return (
    <div className="m-auto text-[13px] text-muted-foreground/70">
      No panel — use + to start one.
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
