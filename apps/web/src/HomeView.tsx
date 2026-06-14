import { DndContext, type DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import type { SessionMeta, WorkState } from '@podium/protocol'
import { Archive, ArchiveRestore, Columns3, Moon, Pencil, Rows3 } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { agentBadge, panelLabel } from './derive'
import { attentionSummary, groupSessions, kanbanColumns, relativeTime } from './home'
import { useStore } from './store'
import { sessionDisplayName } from './WorkerLabel'

type HomeMode = 'list' | 'board'
const MODE_KEY = 'podium.homeMode'

/**
 * The home board — every agent session triaged by where your attention is
 * needed. List mode is the priority feed (needs-you → idle → working); board
 * mode is a kanban over the *work's* state, user-sorted by drag.
 */
export function HomeView(): JSX.Element {
  const { sessions } = useStore()
  const [mode, setMode] = useState<HomeMode>(
    () => (localStorage.getItem(MODE_KEY) as HomeMode) || 'list',
  )
  const [showArchived, setShowArchived] = useState(false)
  // The relative timestamps drift; refresh them once a minute.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const pickMode = (m: HomeMode) => {
    setMode(m)
    localStorage.setItem(MODE_KEY, m)
  }
  const archived = sessions.filter((s) => s.archived)

  return (
    <section className="home">
      <div className="home-head">
        <h1>Command center</h1>
        <div className="home-mode">
          <button
            type="button"
            className={mode === 'list' ? 'active' : ''}
            title="Priority list"
            onClick={() => pickMode('list')}
          >
            <Rows3 size={14} aria-hidden="true" /> List
          </button>
          <button
            type="button"
            className={mode === 'board' ? 'active' : ''}
            title="Kanban board"
            onClick={() => pickMode('board')}
          >
            <Columns3 size={14} aria-hidden="true" /> Board
          </button>
        </div>
      </div>
      {mode === 'list' ? <PriorityList now={now} /> : <KanbanBoard now={now} />}
      {/* In board mode archived sessions live in the Done lane, so this lower
          collapsible would just duplicate them — only show it in list mode. */}
      {mode === 'list' && archived.length > 0 && (
        <div className="home-archived">
          <button type="button" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '▾' : '▸'} Archived ({archived.length})
          </button>
          {showArchived && (
            <div className="home-card-grid">
              {archived.map((s) => (
                <SessionCard key={s.sessionId} session={s} now={now} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function PriorityList({ now }: { now: number }): JSX.Element {
  const { sessions } = useStore()
  const groups = groupSessions(sessions)
  const empty =
    groups.needsYou.length === 0 && groups.idle.length === 0 && groups.working.length === 0
  return (
    <div className="home-groups">
      {empty && (
        <div className="empty">
          No sessions yet. Pick a worktree in the sidebar and start an agent.
        </div>
      )}
      {groups.needsYou.length > 0 && (
        <HomeGroup label="NEEDS YOU" tone="attention" sessions={groups.needsYou} now={now} />
      )}
      {groups.idle.length > 0 && (
        <HomeGroup label="IDLE" tone="idle" sessions={groups.idle} now={now} />
      )}
      {groups.working.length > 0 && (
        <HomeGroup label="WORKING" tone="working" sessions={groups.working} now={now} />
      )}
    </div>
  )
}

function HomeGroup({
  label,
  tone,
  sessions,
  now,
}: {
  label: string
  tone: string
  sessions: SessionMeta[]
  now: number
}): JSX.Element {
  return (
    <div className={`home-group tone-${tone}`}>
      <div className="home-group-label">
        {label} <span className="home-group-count">{sessions.length}</span>
      </div>
      <div className="home-card-grid">
        {sessions.map((s) => (
          <SessionCard key={s.sessionId} session={s} now={now} />
        ))}
      </div>
    </div>
  )
}

function KanbanBoard({ now }: { now: number }): JSX.Element {
  const { sessions, setWorkState } = useStore()
  const lanes = kanbanColumns(sessions)
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const lane = String(over.id)
    void setWorkState(String(active.id), lane === 'unsorted' ? null : (lane as WorkState))
  }
  return (
    <DndContext onDragEnd={onDragEnd}>
      <div className="kanban">
        {lanes.map((lane) => (
          <KanbanLane key={lane.key} laneKey={lane.key} label={lane.label}>
            {lane.sessions.map((s) => (
              <DraggableCard key={s.sessionId} session={s} now={now} />
            ))}
          </KanbanLane>
        ))}
      </div>
    </DndContext>
  )
}

function KanbanLane({
  laneKey,
  label,
  children,
}: {
  laneKey: string
  label: string
  children: React.ReactNode
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: laneKey })
  return (
    <div ref={setNodeRef} className={`kanban-lane ${isOver ? 'over' : ''}`}>
      <div className="kanban-lane-label">{label}</div>
      <div className="kanban-lane-cards">{children}</div>
    </div>
  )
}

function DraggableCard({ session, now }: { session: SessionMeta; now: number }): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: session.sessionId,
  })
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 5 }
    : undefined
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'kanban-card dragging' : 'kanban-card'}
      {...attributes}
      {...listeners}
    >
      <SessionCard session={session} now={now} />
    </div>
  )
}

/** One session on the board: who it is, where it runs, what it wants from you. */
function SessionCard({ session, now }: { session: SessionMeta; now: number }): JSX.Element {
  const {
    setSelectedWorktree,
    setPane,
    setView,
    renameSession,
    archiveSession,
    continueSession,
    hibernateSession,
    resurrectSession,
  } = useStore()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const badge = agentBadge(session)
  const summary = attentionSummary(session)
  const where = session.cwd.split('/').slice(-2).join('/')

  const open = () => {
    // Opening from the archived list is an active reopen — unarchive so the
    // session rejoins the worktree's tab strip, otherwise the workspace would
    // bounce pane A away from it (the strip filters archived sessions out).
    if (session.archived) void archiveSession(session.sessionId, false)
    setSelectedWorktree(session.cwd)
    setPane('A', session.sessionId)
    setView('workspace')
  }
  const commitRename = () => {
    setEditing(false)
    void renameSession(session.sessionId, draft)
  }

  return (
    <div className={`home-card status-${session.status}`}>
      {/* Full-card tap target: one tap anywhere opens the session. The title,
          rename input, edit, and action buttons sit above it (z-index) so they
          keep their own behavior. */}
      {!editing && (
        <button
          type="button"
          className="home-card-hit"
          aria-label={`Open ${sessionDisplayName(session)}`}
          onClick={open}
        />
      )}
      <div className="home-card-title">
        <span className={`dot ${session.status}`} />
        {editing ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the input appears on explicit user intent
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <button type="button" className="home-card-name" onClick={open}>
            {sessionDisplayName(session)}
          </button>
        )}
        <button
          type="button"
          className="home-card-edit"
          title="Rename session"
          onClick={() => {
            setDraft(session.name ?? '')
            setEditing(true)
          }}
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="home-card-meta">
        <span className="home-card-kind">{panelLabel(session.agentKind)}</span>
        <span className="home-card-where" title={session.cwd}>
          {where}
        </span>
        <span className="home-card-when">{relativeTime(session.lastActiveAt, now)}</span>
      </div>
      {badge && <span className={`agent-badge ${badge.tone}`}>{badge.label}</span>}
      {summary && <div className="home-card-summary">{summary}</div>}
      <div className="home-card-actions">
        <button type="button" onClick={open}>
          Open
        </button>
        {badge?.showContinue && (
          <button type="button" onClick={() => void continueSession(session.sessionId)}>
            Continue
          </button>
        )}
        {session.status === 'hibernated' && (
          <button type="button" onClick={() => void resurrectSession(session.sessionId)}>
            Resume
          </button>
        )}
        {session.status === 'live' && session.resumable && (
          <button
            type="button"
            title="Hibernate — free its memory, resume later"
            onClick={() => void hibernateSession(session.sessionId)}
          >
            <Moon size={12} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          title={session.archived ? 'Unarchive' : 'Archive'}
          onClick={() => void archiveSession(session.sessionId, !session.archived)}
        >
          {session.archived ? (
            <ArchiveRestore size={12} aria-hidden="true" />
          ) : (
            <Archive size={12} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  )
}
