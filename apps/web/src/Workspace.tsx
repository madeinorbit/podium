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
import { Pin, X } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AgentPanel } from './AgentPanel'
import { orderTabs, reposToViews, sessionDotClass, sessionsForWorktree } from './derive'
import { NewPanelMenu } from './NewPanelMenu'
import { useStore } from './store'
import type { WorktreeView } from './types'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from './WorkerLabel'

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
    killSession,
  } = store
  // A session created via the "+" menu (or restored from localStorage on reload)
  // lands in `paneA` before the server's broadcast adds it to `tabs`. Without this,
  // the keep-pane-valid effect below sees an unknown paneA and bounces it to
  // tabs[0]. Hold the pane on it until the store actually knows the session.
  const justOpened = useRef<string | null>(paneA)
  // A small drag threshold keeps plain clicks (select/pin/kill) working — the
  // drag only starts once the pointer has actually moved.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const worktree: WorktreeView | undefined = reposToViews(store.repos)
    .flatMap((r) => r.worktrees)
    .find((w) => w.path === selectedWorktree)

  const tabs = worktree
    ? orderTabs(sessionsForWorktree(sessions, worktree.path), tabOrders[worktree.path], pins)
    : []

  // Keep pane A pointed at a valid tab.
  useEffect(() => {
    // Pane A just switched to a session the store hasn't broadcast yet — the "+"
    // menu, a reload restore, OR resume-from-search (which can fire while this
    // Workspace is already mounted, leaving the initial `justOpened` ref stale).
    // Remember it so the fall-back below holds the pane on it instead of bouncing
    // to the worktree's first tab (often an unrelated shell).
    if (paneA && paneA !== justOpened.current && !sessions.some((s) => s.sessionId === paneA)) {
      justOpened.current = paneA
    }
    if (paneA && tabs.some((t) => t.sessionId === paneA)) {
      justOpened.current = null
      return
    }
    // Don't bounce away from a just-opened/restored pane that hasn't reached the
    // store yet; fall back only once the session is known to be gone.
    if (paneA && justOpened.current === paneA && !sessions.some((s) => s.sessionId === paneA)) {
      return
    }
    setPane('A', tabs[0]?.sessionId ?? null)
  }, [tabs, paneA, setPane, sessions])

  if (!worktree)
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/70">
        Select a worktree.
      </div>
    )

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = tabs.map((t) => t.sessionId)
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    void setTabOrder(worktree.path, next)
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
            items={tabs.map((t) => t.sessionId)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex min-w-0 flex-1 items-stretch gap-[3px] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {tabs.map((t) => (
                <SortableTab
                  key={t.sessionId}
                  session={t}
                  active={t.sessionId === paneA}
                  pinned={pins.panels.includes(t.sessionId)}
                  onSelect={() => setPane('A', t.sessionId)}
                  onTogglePin={() =>
                    void setPinned('panel', t.sessionId, !pins.panels.includes(t.sessionId))
                  }
                  onKill={() => void killSession(t.sessionId)}
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
            worktree={worktree}
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
            ⊟
          </Button>
        </div>
      </div>
      {/* Keep every tab's panel mounted; show only the active pane(s) and hide the
          rest (display:none). Switching tabs no longer tears down a terminal and
          replays from scratch — the kept panel just catches up to whatever it
          missed (cheap, and on a flaky link it resumes instead of wiping). `order`
          places the split panes A|B regardless of their tab order in the DOM. */}
      <div className="flex min-h-0 flex-1">
        {tabs.map((t) => {
          const inA = t.sessionId === paneA
          const inB = split && t.sessionId === paneB
          const visible = inA || inB
          return (
            <div
              key={t.sessionId}
              className={cn(
                'min-w-0 flex-1',
                visible ? 'flex' : 'hidden',
                // Split divider on the right-hand pane explicitly — DOM order no
                // longer matches visual order (hidden panes sit between A/B).
                split && inB && !inA && 'border-l border-border',
              )}
              data-session={t.sessionId}
              style={visible ? { order: inA ? 0 : 1 } : undefined}
            >
              <AgentPanel sessionId={t.sessionId} active={visible} />
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
            <PanePicker tabs={tabs} onPick={(id) => setPane('B', id)} />
          </div>
        )}
      </div>
    </section>
  )
}

function SortableTab({
  session,
  active,
  pinned,
  onSelect,
  onTogglePin,
  onKill,
}: {
  session: SessionMeta
  active: boolean
  pinned: boolean
  onSelect: () => void
  onTogglePin: () => void
  onKill: () => void
}): JSX.Element {
  const { renameSession } = useStore()
  const [editing, setEditing] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.sessionId,
  })
  const node = useRef<HTMLDivElement | null>(null)
  // The strip scrolls when crowded — keep the active tab visible in it.
  useEffect(() => {
    if (active) node.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div
      ref={(el) => {
        node.current = el
        setNodeRef(el)
      }}
      // Chrome-like tab sizing: tabs share the strip evenly, shrink as more open,
      // stop at a minimum (then the strip scrolls), and never balloon when alone.
      // `group` drives the hover-reveal of the pin/kill controls below.
      className={cn(
        'group flex max-w-[200px] min-w-[110px] flex-[1_1_180px] items-center rounded-t-md border border-b-0 border-transparent px-0.5',
        isDragging ? 'relative z-[2] cursor-grabbing opacity-90' : 'cursor-grab',
        // The active tab is a solid card that covers the strip's baseline and
        // shares the panel's background — it visibly belongs to the panel below.
        active ? 'border-border bg-card' : isDragging ? 'bg-muted' : 'hover:bg-muted',
      )}
      data-session={session.sessionId}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      {editing ? (
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1">
          <span className={sessionDotClass(session)} />
          <SessionNameEditor
            value={sessionDisplayName(session)}
            onCommit={(name) => {
              void renameSession(session.sessionId, name)
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
          // Double-click a tab to rename it.
          onDoubleClick={() => setEditing(true)}
        >
          <span className={sessionDotClass(session)} /> <WorkerLabel session={session} />
        </button>
      )}
      {/* Chrome-style: pin/kill only appear on the hovered or active tab; a pinned
          tab keeps its pin visible as a state indicator. */}
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
      <button
        type="button"
        className={cn(
          'h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-muted hover:text-destructive',
          active ? 'inline-flex' : 'hidden group-hover:inline-flex',
        )}
        title="Kill session"
        onClick={onKill}
      >
        <X size={12} aria-hidden="true" />
      </button>
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

function PanePicker({
  tabs,
  onPick,
}: {
  tabs: SessionMeta[]
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <div className="m-auto flex flex-col items-center gap-2 text-[13px] text-muted-foreground/70">
      <div>Pick a panel for this pane:</div>
      {tabs.map((t) => (
        <Button key={t.sessionId} variant="secondary" size="sm" onClick={() => onPick(t.sessionId)}>
          <WorkerLabel session={t} />
        </Button>
      ))}
    </div>
  )
}
