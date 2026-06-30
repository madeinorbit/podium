import { DndContext, type DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core'
import type { SessionMeta, WorkState } from '@podium/protocol'
import { Archive, ArchiveRestore, Columns3, Moon, Pencil, Rows3 } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useSessionGuard } from '@/hooks/use-session-guard'
import { cn } from '@/lib/utils'
import { CardBoundary } from './CardBoundary'
import { agentBadge, panelLabel, sessionDotClass } from './derive'
import { attentionSummary, groupSessions, kanbanColumns, relativeTime, withoutShells } from './home'
import { useStore } from './store'
import { sessionDisplayName } from './WorkerLabel'

type HomeMode = 'list' | 'board'
const MODE_KEY = 'podium.homeMode'

function SessionDot({ session }: { session: SessionMeta }): JSX.Element {
  // Shared tone logic — same green/yellow/red/blue semantics as every other surface.
  return <span className={sessionDotClass(session)} />
}

/**
 * The home board — every agent session triaged by where your attention is
 * needed. List mode is the priority feed (needs-you → idle → working); board
 * mode is a kanban over the *work's* state, user-sorted by drag.
 */
export function HomeView(): JSX.Element {
  const { sessions } = useStore()
  const isMobile = useIsMobile()
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
  const archived = withoutShells(sessions).filter((s) => s.archived)

  return (
    <section
      className={cn(
        'min-w-0 flex-1 overflow-y-auto',
        isMobile ? 'px-3 pt-3 pb-6' : 'px-[22px] pt-[18px] pb-8',
      )}
    >
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h1 className="m-0 text-[17px] font-medium text-foreground">Command center</h1>
        <div className="flex gap-1">
          <Button
            type="button"
            variant={mode === 'list' ? 'default' : 'outline'}
            size="sm"
            title="Priority list"
            onClick={() => pickMode('list')}
          >
            <Rows3 size={14} aria-hidden="true" /> List
          </Button>
          <Button
            type="button"
            variant={mode === 'board' ? 'default' : 'outline'}
            size="sm"
            title="Kanban board"
            onClick={() => pickMode('board')}
          >
            <Columns3 size={14} aria-hidden="true" /> Board
          </Button>
        </div>
      </div>
      {mode === 'list' ? <PriorityList now={now} /> : <KanbanBoard now={now} />}
      {/* In board mode archived sessions live in the Done lane, so this lower
          collapsible would just duplicate them — only show it in list mode. */}
      {mode === 'list' && archived.length > 0 && (
        <div className="mt-[22px]">
          <button
            type="button"
            className="mb-2 cursor-pointer border-0 bg-transparent text-xs text-muted-foreground/70"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? '▾' : '▸'} Archived ({archived.length})
          </button>
          {showArchived && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2.5">
              {archived.map((s) => (
                <CardBoundary key={s.sessionId} resetKey={s.sessionId} label="session card">
                  <SessionCard session={s} now={now} archivedDim />
                </CardBoundary>
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
  const groups = groupSessions(withoutShells(sessions))
  const empty =
    groups.needsYou.length === 0 && groups.idle.length === 0 && groups.working.length === 0
  return (
    <div className="flex flex-col gap-[18px]">
      {empty && (
        <div className="p-3 text-xs text-muted-foreground/70">
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
    <div>
      <div
        className={cn(
          'mb-2 text-[11px] font-bold tracking-[0.08em]',
          tone === 'attention' ? 'text-warning' : 'text-muted-foreground',
        )}
      >
        {label} <span className="ml-1 font-normal text-muted-foreground/70">{sessions.length}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2.5">
        {sessions.map((s) => (
          <CardBoundary key={s.sessionId} resetKey={s.sessionId} label="session card">
            <SessionCard session={s} now={now} attention={tone === 'attention'} />
          </CardBoundary>
        ))}
      </div>
    </div>
  )
}

function KanbanBoard({ now }: { now: number }): JSX.Element {
  const { sessions, setWorkState } = useStore()
  const lanes = kanbanColumns(withoutShells(sessions))
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const lane = String(over.id)
    void setWorkState(String(active.id), lane === 'unsorted' ? null : (lane as WorkState))
  }
  return (
    <DndContext onDragEnd={onDragEnd}>
      <div className="flex items-start gap-2.5 overflow-x-auto pb-2">
        {lanes.map((lane) => (
          <KanbanLane key={lane.key} laneKey={lane.key} label={lane.label}>
            {lane.sessions.map((s) => (
              <CardBoundary key={s.sessionId} resetKey={s.sessionId} label="session card">
                <DraggableCard session={s} now={now} />
              </CardBoundary>
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
    <div
      ref={setNodeRef}
      className={cn(
        'min-h-[120px] flex-[0_0_240px] rounded-md border bg-card p-2',
        isOver ? 'border-primary' : 'border-border',
      )}
    >
      <div className="px-1 pt-0.5 pb-2 text-[11px] font-bold tracking-[0.07em] text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
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
      className={cn('touch-none', isDragging ? 'relative cursor-grabbing' : 'cursor-grab')}
      {...attributes}
      {...listeners}
    >
      <SessionCard session={session} now={now} raised />
    </div>
  )
}

/** One session on the board: who it is, where it runs, what it wants from you. */
function SessionCard({
  session,
  now,
  attention,
  raised,
  archivedDim,
}: {
  session: SessionMeta
  now: number
  attention?: boolean
  raised?: boolean
  archivedDim?: boolean
}): JSX.Element {
  const {
    machines,
    setSelectedWorktree,
    setPane,
    setView,
    renameSession,
    archiveSession,
    continueSession,
    hibernateSession,
    resurrectSession,
  } = useStore()
  const { guardedArchive } = useSessionGuard()
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
    <div
      className={cn(
        'group/card relative flex min-w-0 flex-col gap-1.5 rounded-md border px-3 py-2.5',
        raised ? 'bg-muted' : 'bg-card',
        attention ? 'border-warning/45' : 'border-border',
        archivedDim && 'opacity-65',
      )}
    >
      {/* Full-card tap target: one tap anywhere opens the session. The title,
          rename input, edit, and action buttons sit above it (z-index) so they
          keep their own behavior. */}
      {!editing && (
        <button
          type="button"
          className="absolute inset-0 z-0 m-0 size-full cursor-pointer border-0 bg-transparent p-0"
          aria-label={`Open ${sessionDisplayName(session)}`}
          onClick={open}
        />
      )}
      <div className="relative z-[1] flex min-w-0 items-center gap-[7px]">
        <SessionDot session={session} />
        {editing ? (
          <Input
            // biome-ignore lint/a11y/noAutofocus: the input appears on explicit user intent
            autoFocus
            className="h-auto min-w-0 flex-1 rounded border-primary bg-background px-1.5 py-0.5 text-[13px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[13px] font-semibold text-foreground hover:text-primary"
            onClick={open}
            title={sessionDisplayName(session)}
          >
            {sessionDisplayName(session)}
          </button>
        )}
        <button
          type="button"
          className="relative z-[1] inline-flex cursor-pointer border-0 bg-transparent p-0.5 text-muted-foreground/70 opacity-0 hover:text-foreground group-hover/card:opacity-100"
          title="Rename session"
          onClick={() => {
            setDraft(session.name ?? '')
            setEditing(true)
          }}
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-w-0 items-baseline gap-2 text-[11px] text-muted-foreground">
        <span className="tracking-[0.04em] text-muted-foreground/70 [font-variant:all-small-caps]">
          {panelLabel(session.agentKind)}
        </span>
        <span className="min-w-0 truncate" title={session.cwd}>
          {where}
        </span>
        {/* Machine badge: only when > 1 machine is connected. */}
        {machines.length > 1 && session.machineName && (
          <Badge
            variant="outline"
            className="shrink-0 border-border/50 py-0 text-[10px] font-normal text-muted-foreground/70"
            aria-label={`Running on ${session.machineName}`}
          >
            {session.machineName}
          </Badge>
        )}
        <span className="ml-auto whitespace-nowrap text-muted-foreground/70">
          {relativeTime(session.lastActiveAt, now)}
        </span>
      </div>
      {summary && (
        <div className="rounded bg-accent px-2 py-1.5 text-xs text-foreground [overflow-wrap:anywhere]">
          {summary}
        </div>
      )}
      <div className="relative z-[1] mt-0.5 flex gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={open}>
          Open
        </Button>
        {badge?.showContinue && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void continueSession(session.sessionId)}
          >
            Continue
          </Button>
        )}
        {session.status === 'hibernated' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void resurrectSession(session.sessionId)}
          >
            Resume
          </Button>
        )}
        {session.status === 'live' && session.resumable && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            title="Hibernate — free its memory, resume later"
            onClick={() => void hibernateSession(session.sessionId)}
          >
            <Moon size={12} aria-hidden="true" />
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          title={session.archived ? 'Unarchive' : 'Archive'}
          onClick={() => void guardedArchive(session.sessionId, !session.archived)}
        >
          {session.archived ? (
            <ArchiveRestore size={12} aria-hidden="true" />
          ) : (
            <Archive size={12} aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  )
}
