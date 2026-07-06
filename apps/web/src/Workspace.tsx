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
import type { SessionMeta } from '@podium/protocol'
import { Columns2, FileText, Pin, X } from 'lucide-react'
import { type JSX, lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useSessionGuard } from '@/hooks/use-session-guard'
import { cn } from '@/lib/utils'
import { AgentPanel } from './AgentPanel'
import {
  agentColorHex,
  orderTabs,
  orphanSessionFor,
  reposToViews,
  sessionDotClass,
  sessionsForIssueNav,
  sessionsForWorktree,
} from './derive'
import { NewPanelMenu } from './NewPanelMenu'
import { type ContextMenuAnchor, SessionContextMenu } from './SessionContextMenu'
import { type FileTab, useStore } from './store'
import type { WorktreeView } from './types'
import { useWarmSet } from './use-warm-set'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from './WorkerLabel'

const FilePanel = lazy(() => import('./FilePanel').then((m) => ({ default: m.FilePanel })))

// A tab in the strip is either an agent/shell session or an open file editor. Both are
// first-class: same strip, same drag/select/close behaviour. paneA/paneB hold a tab id
// (sessionId for sessions, the FileTab.id `file:…` for files).
type WTab =
  | { id: string; kind: 'session'; session: SessionMeta }
  | { id: string; kind: 'file'; file: FileTab }

const tabName = (t: WTab): string =>
  t.kind === 'file' ? (t.file.path.split('/').pop() ?? t.file.path) : ''

export function Workspace(): JSX.Element {
  const store = useStore()
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
  } = store
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

  const allWorktrees = reposToViews(store.repos).flatMap((r) => r.worktrees)
  const allWorktreePaths = allWorktrees.map((w) => w.path)
  const worktree: WorktreeView | undefined = allWorktrees.find((w) => w.path === selectedWorktree)

  // Issue-keyed workspace (issue-as-workspace, unified layout only): when an
  // issue row is selected, the tab strip shows the issue's sessions (explicit
  // issueId first-class + cwd-contained legacy) instead of a worktree's.
  const issue =
    store.sidebarLayout === 'unified' && store.selectedIssueId
      ? store.issues.find((i) => i.id === store.selectedIssueId && !i.archived)
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
  const sessionList = issue
    ? sessionsForIssueNav(issue, sessions, allWorktreePaths, { includeShells: true })
    : worktree
      ? sessionsForWorktree(sessions, worktree.path, allWorktreePaths)
      : []
  const fileList = issue
    ? issue.worktreePath
      ? fileTabs.filter((f) => f.worktreePath === issue.worktreePath)
      : []
    : worktree
      ? fileTabs.filter((f) => f.worktreePath === worktree.path)
      : []
  const orderKey = issue ? `issue:${issue.id}` : worktree?.path
  const byId = new Map<string, WTab>()
  for (const s of sessionList)
    byId.set(s.sessionId, { id: s.sessionId, kind: 'session', session: s })
  for (const f of fileList) byId.set(f.id, { id: f.id, kind: 'file', file: f })
  const baseIds = [
    ...orderTabs(sessionList, undefined, pins).map((s) => s.sessionId),
    ...fileList.map((f) => f.id),
  ]
  const manual = orderKey ? tabOrders[orderKey] : undefined
  const orderedIds =
    manual && manual.length
      ? [...manual.filter((id) => byId.has(id)), ...baseIds.filter((id) => !manual.includes(id))]
      : baseIds
  const allTabs: WTab[] = orderedIds.map((id) => byId.get(id)).filter((t): t is WTab => !!t)

  // Cap how many session panels stay mounted: the active pane(s) plus the most
  // recently viewed others up to an LRU limit (8 desktop / 3 mobile). Evicted
  // session tabs render nothing (unmount → dispose → free WebGL/memory); clicking
  // one re-activates it, re-entering the warm set so it remounts cold.
  const sessionIds = allTabs.filter((t) => t.kind === 'session').map((t) => t.id)
  const activeIds = [paneA, split ? paneB : null].filter((x): x is string => x != null)
  const warm = useWarmSet(sessionIds, activeIds)

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
    <section className="relative flex min-w-0 flex-1 flex-col">
      <div className="relative flex items-stretch gap-2 border-b border-border bg-background px-2 pt-1.5">
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
            <div className="flex min-w-0 flex-1 items-stretch gap-[3px] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {allTabs.map((t) => (
                <SortableTab
                  key={t.id}
                  tab={t}
                  active={t.id === paneA}
                  pinned={t.kind === 'session' && pins.panels.includes(t.id)}
                  onSelect={() => setPane('A', t.id)}
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
            </div>
          </SortableContext>
        </DndContext>
        <div className="flex flex-none items-center gap-1 pb-1.5">
          {/* NewPanelMenu owns its own "+" trigger button and a portalled,
              auto-positioned dropdown (Base UI Positioner handles collision/
              clamping), so the parent no longer renders/positions the menu. */}
          <NewPanelMenu
            // biome-ignore lint/style/noNonNullAssertion: the early return above guarantees worktree or issue (which makes panelTarget defined)
            worktree={panelTarget!}
            issueId={issue?.id}
            onOpened={(sid) => {
              justOpened.current = sid
              setPane('A', sid)
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            title="Split"
            aria-label="Split"
            onClick={toggleSplit}
          >
            <Columns2 size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {/* Keep every tab's panel mounted; show only the active pane(s) and hide the
          rest (display:none). `order` places the split panes A|B regardless of DOM order. */}
      <div className="flex min-h-0 flex-1">
        {allTabs.map((t) => {
          const inA = t.id === paneA
          const inB = split && t.id === paneB
          const visible = inA || inB
          // Evicted (cold) session tabs render nothing — clicking the tab makes it
          // active → warm → it remounts. The `!visible` guard is load-bearing: the
          // hook updates `warm` in an effect (one render behind), so a just-activated
          // pane may not be in `warm` yet — always mount the visible pane regardless,
          // or it blanks for a frame. File tabs are cheap and always render.
          if (t.kind === 'session' && !visible && !warm.has(t.id)) return null
          return (
            <div
              key={t.id}
              className={cn(
                'min-w-0 flex-1',
                visible ? 'flex' : 'hidden',
                split && inB && !inA && 'border-l border-border',
              )}
              data-session={t.id}
              style={visible ? { order: inA ? 0 : 1 } : undefined}
            >
              {t.kind === 'session' ? (
                <AgentPanel sessionId={t.id} active={visible} />
              ) : (
                <Suspense fallback={null}>
                  <FilePanel
                    scope={t.file.scope}
                    path={t.file.path}
                    onClose={() => closeFileTab(t.id)}
                  />
                </Suspense>
              )}
            </div>
          )
        })}
        {!paneA && (
          <div className="flex min-w-0 flex-1" style={{ order: 0 }}>
            <Empty />
          </div>
        )}
        {split && !paneB && (
          <div className="flex min-w-0 flex-1 border-l border-border" style={{ order: 1 }}>
            <PanePicker tabs={allTabs} onPick={(id) => setPane('B', id)} />
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
  onSelect,
  onTogglePin,
  onClose,
}: {
  tab: WTab
  active: boolean
  pinned: boolean
  onSelect: () => void
  onTogglePin?: () => void
  onClose: () => void
}): JSX.Element {
  const { renameSession } = useStore()
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
  const accent = tab.kind === 'session' ? agentColorHex(tab.session.agentColor) : undefined
  return (
    <div
      ref={(el) => {
        node.current = el
        setNodeRef(el)
      }}
      // Chrome-like tab sizing: tabs share the strip evenly, shrink as more open, stop at
      // a minimum (then the strip scrolls), and never balloon when alone. `group` drives
      // the hover-reveal of the pin/close controls.
      className={cn(
        'group relative flex max-w-[200px] min-w-[110px] flex-[1_1_180px] items-center rounded-t-md border border-b-0 border-transparent px-0.5',
        isDragging ? 'z-[2] cursor-grabbing opacity-90' : 'cursor-grab',
        active ? 'border-border bg-card' : isDragging ? 'bg-muted' : 'hover:bg-muted',
      )}
      data-session={tab.id}
      title={tab.kind === 'file' ? tab.file.path : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      {accent && (
        <span
          className="pointer-events-none absolute inset-x-1 top-0 h-[2px] rounded-full"
          style={{ background: accent }}
          aria-hidden="true"
        />
      )}
      {tab.kind === 'session' && editing ? (
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1">
          <span className={sessionDotClass(tab.session)} />
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
            'inline-flex min-w-0 flex-1 cursor-[inherit] items-center gap-1.5 rounded-none px-2.5 py-1 text-[13px] whitespace-nowrap',
            active ? 'font-medium text-foreground' : 'text-muted-foreground',
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
              <span className={sessionDotClass(tab.session)} />{' '}
              <WorkerLabel session={tab.session} />
            </>
          ) : (
            <>
              <FileText
                size={12}
                aria-hidden="true"
                className="flex-none text-muted-foreground/70"
              />
              <span className="truncate">{tabName(tab)}</span>
            </>
          )}
        </button>
      )}
      {tab.kind === 'session' && onTogglePin && (
        <button
          type="button"
          className={cn(
            'h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-muted hover:text-primary',
            pinned ? 'inline-flex text-primary' : 'hidden group-hover:inline-flex',
          )}
          aria-pressed={pinned}
          title={pinned ? 'Unpin panel' : 'Pin panel'}
          onClick={onTogglePin}
        >
          <Pin size={12} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className={cn(
          'h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-muted hover:text-destructive',
          active ? 'inline-flex' : 'hidden group-hover:inline-flex',
        )}
        title={tab.kind === 'session' ? 'Kill session' : 'Close file'}
        onClick={onClose}
      >
        <X size={12} aria-hidden="true" />
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
