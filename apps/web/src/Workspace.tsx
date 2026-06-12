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
import { Pin } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { orderTabs, reposToViews, sessionsForWorktree } from './derive'
import { NewPanelMenu } from './NewPanelMenu'
import { useStore } from './store'
import type { WorktreeView } from './types'
import { WorkerLabel } from './WorkerLabel'

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
  const [menuOpen, setMenuOpen] = useState(false)
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
    if (paneA && tabs.some((t) => t.sessionId === paneA)) return
    setPane('A', tabs[0]?.sessionId ?? null)
  }, [tabs, paneA, setPane])

  if (!worktree) return <div className="workspace empty">Select a worktree.</div>

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = tabs.map((t) => t.sessionId)
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    void setTabOrder(worktree.path, next)
  }

  return (
    <section className="workspace">
      <div className="tabbar">
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
            <div className="tabbar-tabs">
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
        <div className="tabbar-actions">
          <button
            type="button"
            className="tab-add"
            title="New panel"
            onClick={() => setMenuOpen((v) => !v)}
          >
            +
          </button>
          <button type="button" className="tab-split" onClick={toggleSplit}>
            ⊟ split
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className="workspace-menu-layer">
          <NewPanelMenu
            worktree={worktree}
            onOpened={(sid) => {
              setPane('A', sid)
              setMenuOpen(false)
            }}
          />
        </div>
      )}
      <div className={split ? 'panes split' : 'panes'}>
        <div className="pane">{paneA ? <AgentPanel sessionId={paneA} /> : <Empty />}</div>
        {split && (
          <div className="pane">
            {paneB ? (
              <AgentPanel sessionId={paneB} />
            ) : (
              <PanePicker tabs={tabs} onPick={(id) => setPane('B', id)} />
            )}
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.sessionId,
  })
  const node = useRef<HTMLDivElement | null>(null)
  // The strip scrolls when crowded — keep the active tab visible in it.
  useEffect(() => {
    if (active) node.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  const cls = ['tab-wrap', active ? 'active' : '', isDragging ? 'dragging' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div
      ref={(el) => {
        node.current = el
        setNodeRef(el)
      }}
      className={cls}
      data-session={session.sessionId}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <button type="button" className="tab" onClick={onSelect}>
        <span className={`dot ${session.status}`} /> <WorkerLabel session={session} />
      </button>
      <button
        type="button"
        className={pinned ? 'tab-pin active' : 'tab-pin'}
        aria-pressed={pinned}
        title={pinned ? 'Unpin panel' : 'Pin panel'}
        onClick={onTogglePin}
      >
        <Pin size={12} aria-hidden="true" />
      </button>
      <button type="button" className="tab-kill" title="Kill session" onClick={onKill}>
        ✕
      </button>
    </div>
  )
}

function Empty(): JSX.Element {
  return <div className="pane-empty">No panel — use + to start one.</div>
}

function PanePicker({
  tabs,
  onPick,
}: {
  tabs: SessionMeta[]
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <div className="pane-picker">
      <div>Pick a panel for this pane:</div>
      {tabs.map((t) => (
        <button key={t.sessionId} type="button" onClick={() => onPick(t.sessionId)}>
          <WorkerLabel session={t} />
        </button>
      ))}
    </div>
  )
}
