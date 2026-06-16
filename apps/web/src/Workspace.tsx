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
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AgentPanel } from './AgentPanel'
import { orderTabs, reposToViews, sessionDotClass, sessionsForWorktree } from './derive'
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
  // The "+" sits at the right of the tab bar, so a left-anchored dropdown spills
  // off the right edge of the window. Measure once it's open (and on resize / when
  // its async resume list changes height) and slide it horizontally so it stays
  // fully on screen, wherever the button is.
  const menuLayerRef = useRef<HTMLDivElement | null>(null)
  // Wraps the "+" and its dropdown — used to detect clicks outside both.
  const addWrapRef = useRef<HTMLDivElement | null>(null)
  const [menuShift, setMenuShift] = useState(0)
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuShift(0)
      return
    }
    const el = menuLayerRef.current
    if (!el) return
    const clamp = () => {
      const margin = 8
      // Measure at the un-shifted baseline, then compute the slide that keeps both
      // edges inside the viewport (right edge wins when it can't fit both).
      const applied = el.style.left
      el.style.left = '0px'
      const rect = el.getBoundingClientRect()
      el.style.left = applied
      let shift = 0
      const overRight = rect.right - (window.innerWidth - margin)
      if (overRight > 0) shift = -overRight
      if (rect.left + shift < margin) shift = margin - rect.left
      setMenuShift(shift)
    }
    clamp()
    const ro = new ResizeObserver(clamp)
    ro.observe(el)
    window.addEventListener('resize', clamp)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', clamp)
    }
  }, [menuOpen])
  // Dismiss the dropdown on a click anywhere outside it (or Escape). The "+" lives
  // inside addWrapRef too, so its own toggle isn't treated as an outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent) => {
      if (!addWrapRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])
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
          <div className="tab-add-wrap" ref={addWrapRef}>
            <button
              type="button"
              className="tab-add"
              title="New panel"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              +
            </button>
            {menuOpen && (
              <div
                className="workspace-menu-layer"
                ref={menuLayerRef}
                style={{ left: `${menuShift}px` }}
              >
                <NewPanelMenu
                  worktree={worktree}
                  onOpened={(sid) => {
                    justOpened.current = sid
                    setPane('A', sid)
                    setMenuOpen(false)
                  }}
                />
              </div>
            )}
          </div>
          <button type="button" className="tab-split" onClick={toggleSplit}>
            ⊟ split
          </button>
        </div>
      </div>
      {/* Keep every tab's panel mounted; show only the active pane(s) and hide the
          rest (display:none). Switching tabs no longer tears down a terminal and
          replays from scratch — the kept panel just catches up to whatever it
          missed (cheap, and on a flaky link it resumes instead of wiping). `order`
          places the split panes A|B regardless of their tab order in the DOM. */}
      <div className={split ? 'panes split' : 'panes'}>
        {tabs.map((t) => {
          const inA = t.sessionId === paneA
          const inB = split && t.sessionId === paneB
          const visible = inA || inB
          const cls = `pane${visible ? '' : ' pane-hidden'}${inB && !inA ? ' pane-b' : ''}`
          return (
            <div
              key={t.sessionId}
              className={cls}
              data-session={t.sessionId}
              style={visible ? { order: inA ? 0 : 1 } : undefined}
            >
              <AgentPanel sessionId={t.sessionId} active={visible} />
            </div>
          )
        })}
        {!paneA && (
          <div className="pane" style={{ order: 0 }}>
            <Empty />
          </div>
        )}
        {split && !paneB && (
          <div className="pane pane-b" style={{ order: 1 }}>
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
        <span className={sessionDotClass(session)} /> <WorkerLabel session={session} />
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
