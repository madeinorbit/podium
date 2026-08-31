import {
  deckSessions,
  type FlightDeckMode,
  type FlightDeckRow,
  isCoordinatorSession,
  nativeSubagentRows,
  sessionAsksOnIssue,
  sessionUnreadEmphasized,
} from '@podium/client-core/viewmodels'
import type { IssueId, SessionMeta } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { ChevronDown, ChevronRight, Ellipsis } from 'lucide-react'
import type { CSSProperties, JSX, MouseEvent as ReactMouseEvent } from 'react'
import { memo, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { SessionContextMenu } from '@/lib/SessionContextMenu'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { KindIcon, SessionNameEditor, sessionDisplayName } from '@/lib/WorkerLabel'
import { cn } from '@/lib/utils'
import { useClickIntent } from './click-intent'
import { useSessionHovered } from './session-hover'
import { useStoreSelector } from './store'
import type { FlightDeckDisplay } from './flight-deck-display'
import {
  buildWaterfallTimelineFromStart,
  formatWaterfallDuration,
  waterfallAxisTicks,
  waterfallInterval,
  waterfallTimelineStart,
} from './flight-deck-waterfall'

interface WaterfallIssueRow {
  row: FlightDeckRow
  displayTitle: string
  sessions: SessionMeta[]
  root: boolean
}

interface FlightDeckWaterfallProps {
  rootRow: FlightDeckRow
  rows: readonly FlightDeckRow[]
  displayTitles: ReadonlyMap<string, string>
  mode: FlightDeckMode
  display: FlightDeckDisplay
  focusedIssueId: string | null
  activeSessionId: string | null
  renameTarget: { id: string; seed: string } | null
  isFolded: (row: FlightDeckRow) => boolean
  onToggle: (row: FlightDeckRow) => void
  onSelectIssue: (row: FlightDeckRow, permanent: boolean) => void
  onSelectSession: (
    issueId: IssueId,
    session: SessionMeta,
    options: { permanent: boolean; native?: boolean },
  ) => void
  onIssueMenu: (issueId: IssueId, event: ReactMouseEvent) => void
  onStatusPick: (issueId: string, value: string) => void
  onRenameIssue: (issueId: string, title: string, openedTitle: string) => void
  onRenameDone: () => void
}

function issueFutureLabel(row: FlightDeckRow): string | null {
  const issue = row.issue
  const question = issue.humanQuestion?.trim()
  if (question) return `Waiting for operator: ${question}`
  const blocked = issue.blockedByNotes?.map((note) => note.trim()).find(Boolean)
  if (blocked) return `Blocked: ${blocked}`
  const dependency = issue.dependencyNote?.trim()
  if (dependency) return `Waiting: ${dependency}`
  if (issue.stage === 'proposed') return 'Known next step · unassigned'
  if (row.sessions.length === 0 && issue.stage !== 'done') return 'Unassigned'
  return null
}

function sessionReason(row: FlightDeckRow, session: SessionMeta): string | null {
  const runtime = session.agentState?.need?.summary?.trim()
  if (runtime) return runtime
  if (!sessionAsksOnIssue(row.issue, session)) return null
  return row.issue.humanQuestion?.trim() || 'Waiting for operator'
}

const WaterfallAxis = memo(function WaterfallAxis({
  timelineStart,
}: {
  timelineStart: number | null
}): JSX.Element {
  const now = useStoreSelector((store) => store.coarseNow)
  const timeline = useMemo(
    () => buildWaterfallTimelineFromStart(timelineStart, now),
    [now, timelineStart],
  )
  const ticks = useMemo(() => waterfallAxisTicks(timeline), [timeline])
  return (
    <>
      <div className="waterfall-axis">
        <span className="waterfall-axis-title">Task / session</span>
        <div className="waterfall-axis-track" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.left} style={{ left: `${tick.left}%` }}>
              {tick.label}
            </span>
          ))}
          <span className="waterfall-axis-now" style={{ left: `${timeline.nowPercent}%` }}>
            Now
          </span>
        </div>
      </div>
      <div
        className="waterfall-now-line"
        style={{ '--waterfall-now': `${timeline.nowPercent}%` } as CSSProperties}
        aria-hidden="true"
      />
    </>
  )
})

const WaterfallSessionBar = memo(function WaterfallSessionBar({
  row,
  session,
  timelineStart,
  selected,
  onOpen,
  onOpenNative,
}: {
  row: FlightDeckRow
  session: SessionMeta
  timelineStart: number | null
  selected: boolean
  onOpen: (permanent: boolean) => void
  onOpenNative: () => void
}): JSX.Element {
  const intent = useClickIntent()
  const now = useStoreSelector((store) => store.coarseNow)
  const renameSession = useStoreSelector((store) => store.renameSession)
  const timeline = useMemo(
    () => buildWaterfallTimelineFromStart(timelineStart, now),
    [now, timelineStart],
  )
  const interval = waterfallInterval(session, timeline)
  const asking = sessionAsksOnIssue(row.issue, session)
  const state = asking ? 'attention' : interval.state
  const reason = sessionReason(row, session)
  const name = sessionDisplayName(session)
  const ref = session.displayRef?.trim()
  const coordinator = isCoordinatorSession(row.issue, session.sessionId)
  const workers = useMemo(() => nativeSubagentRows(session), [session])
  const pointed = useSessionHovered(session.sessionId)
  const unread = sessionUnreadEmphasized(session)
  const [nativeOpen, setNativeOpen] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  const nativeListId = useId()
  const openMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenuAnchor({
      x: event.clientX || rect.right,
      y: event.clientY || rect.bottom,
    })
  }
  const label = [
    ref,
    name,
    coordinator ? 'coordinator' : null,
    reason,
    unread ? 'unread' : null,
    workers.length > 0
      ? `${workers.length} active native worker${workers.length === 1 ? '' : 's'}`
      : null,
    formatWaterfallDuration(interval.end - interval.start),
    state === 'finished' ? 'finished' : state === 'working' ? 'working now' : 'live',
  ]
    .filter(Boolean)
    .join(' · ')
  const geometry = {
    '--waterfall-left': `${interval.left}%`,
    '--waterfall-width': `${interval.width}%`,
  } as CSSProperties
  return (
    <div
      className="waterfall-session-lane"
      data-pointed={pointed || undefined}
      data-unread={unread || undefined}
      data-has-native={workers.length > 0 || undefined}
      style={geometry}
    >
      {editing ? (
        <div className="waterfall-session-editor">
          <SessionNameEditor
            value={name}
            onCommit={(next) => {
              void renameSession(session.sessionId, next)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          <button
            data-pressable
            type="button"
            className="waterfall-session-bar"
            data-flight-session={session.sessionId}
            data-state={state}
            data-selected={selected || undefined}
            data-clipped-start={interval.clippedStart || undefined}
            data-pointed={pointed || undefined}
            data-unread={unread || undefined}
            aria-label={label}
            aria-pressed={selected}
            onClick={() =>
              intent.press(
                () => onOpen(false),
                () => onOpen(true),
              )
            }
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              intent.commit(() => onOpen(true))
            }}
            onContextMenu={openMenu}
          >
            <KindIcon kind={session.agentKind} compact dimmed={state === 'finished'} />
            <span className="waterfall-session-name">{name}</span>
            {unread ? (
              <>
                <span className="waterfall-unread-dot" aria-hidden="true" />
                <span className="sr-only">unread</span>
              </>
            ) : null}
            <span className="waterfall-session-time font-mono tabular-nums">
              {formatWaterfallDuration(interval.end - interval.start)}
            </span>
          </button>
          <div className="waterfall-session-tools">
            {workers.length > 0 ? (
              <button
                data-pressable
                type="button"
                className="waterfall-native-toggle"
                aria-label={`${nativeOpen ? 'Hide' : 'Show'} ${workers.length} native worker${workers.length === 1 ? '' : 's'} for ${name}`}
                aria-expanded={nativeOpen}
                aria-controls={nativeListId}
                onClick={() => setNativeOpen((open) => !open)}
              >
                +{workers.length}
              </button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className="waterfall-session-menu"
              aria-label={`Session actions for ${name}`}
              title="Session actions"
              onClick={openMenu}
            >
              <Ellipsis size={11} aria-hidden="true" />
            </Button>
          </div>
        </>
      )}
      {nativeOpen && workers.length > 0 ? (
        <div id={nativeListId} className="waterfall-native-list" data-testid="flight-native-agents">
          {workers.map((worker) => {
            const workerName = worker.anonymous ? 'unnamed worker' : `worker ${worker.id}`
            return (
              <button
                data-pressable
                key={`${session.sessionId}:${worker.id}`}
                type="button"
                className="waterfall-native-worker"
                data-native-worker={worker.id}
                aria-label={`Open ${name} native panel for ${worker.type} ${workerName}`}
                title={`Open ${name} native panel · ${worker.type} ${workerName}`}
                onClick={onOpenNative}
              >
                <span className="waterfall-native-worker-name">
                  {worker.type}
                  {!worker.anonymous ? ` · ${worker.id.slice(0, 8)}` : ''}
                </span>
                <span>{worker.working ? 'working' : 'waiting'}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      {reason ? <span className="waterfall-wait-reason">{reason}</span> : null}
      {menuAnchor ? (
        <SessionContextMenu
          session={session}
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          onRename={() => {
            setMenuAnchor(null)
            setEditing(true)
          }}
        />
      ) : null}
    </div>
  )
})

const WaterfallIssue = memo(function WaterfallIssue({
  item,
  timelineStart,
  focused,
  activeSessionId,
  renameSeed,
  folded,
  onToggle,
  onSelectIssue,
  onSelectSession,
  onSelectNative,
  onIssueMenu,
  onStatusPick,
  onRenameIssue,
  onRenameDone,
}: {
  item: WaterfallIssueRow
  timelineStart: number | null
  focused: boolean
  activeSessionId: string | null
  renameSeed: string | null
  folded: boolean
  onToggle: () => void
  onSelectIssue: (permanent: boolean) => void
  onSelectSession: (session: SessionMeta, permanent: boolean) => void
  onSelectNative: (session: SessionMeta) => void
  onIssueMenu: (event: ReactMouseEvent) => void
  onStatusPick: (value: string) => void
  onRenameIssue: (title: string) => void
  onRenameDone: () => void
}): JSX.Element {
  const intent = useClickIntent()
  const future = issueFutureLabel(item.row)
  const foldable = !item.root && (item.row.descendantIds.length > 0 || item.row.sessions.length > 0)
  const indent = item.root ? 0 : Math.max(0, item.row.depth - 1)
  return (
    <div
      className="waterfall-issue-row"
      data-flight-issue={item.row.issue.id}
      data-depth={item.row.depth}
      data-focused={focused || undefined}
      style={{ '--waterfall-depth': indent } as CSSProperties}
    >
      <div className="waterfall-issue-cell" onContextMenu={onIssueMenu}>
        <span className="waterfall-tree-guides" aria-hidden="true" />
        {foldable ? (
          <button
            data-pressable
            type="button"
            className="waterfall-fold"
            aria-label={folded ? `Expand ${item.displayTitle}` : `Collapse ${item.displayTitle}`}
            aria-expanded={!folded}
            onClick={onToggle}
          >
            {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
        ) : (
          <span className="waterfall-fold" aria-hidden="true" />
        )}
        <IssueStatusPicker issue={item.row.issue} size={12} onPick={onStatusPick} />
        {renameSeed !== null ? (
          <span className="min-w-0 flex-1 py-0.5">
            <SessionNameEditor
              value={renameSeed}
              onCommit={(title) => {
                onRenameIssue(title)
                onRenameDone()
              }}
              onCancel={onRenameDone}
            />
          </span>
        ) : (
          <button
            data-pressable
            type="button"
            className="waterfall-issue-open"
            aria-current={focused ? 'true' : undefined}
            onClick={() =>
              intent.press(
                () => onSelectIssue(false),
                () => onSelectIssue(true),
              )
            }
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              intent.commit(() => onSelectIssue(true))
            }}
          >
            <span className="waterfall-issue-ref font-mono">{issueDisplayRef(item.row.issue)}</span>
            <span className="waterfall-issue-title">{item.displayTitle}</span>
          </button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="waterfall-issue-menu size-5 text-text-faint"
          aria-label={`Task actions for ${item.displayTitle}`}
          onClick={onIssueMenu}
        >
          <Ellipsis size={11} aria-hidden="true" />
        </Button>
      </div>
      <div className="waterfall-track-cell">
        {item.sessions.length > 0 ? (
          item.sessions.map((session) => (
            <WaterfallSessionBar
              key={session.sessionId}
              row={item.row}
              session={session}
              timelineStart={timelineStart}
              selected={session.sessionId === activeSessionId}
              onOpen={(permanent) => onSelectSession(session, permanent)}
              onOpenNative={() => onSelectNative(session)}
            />
          ))
        ) : future ? (
          <span className="waterfall-future-label">{future}</span>
        ) : (
          <span className="waterfall-empty-label">No session</span>
        )}
      </div>
    </div>
  )
})

export function FlightDeckWaterfall({
  rootRow,
  rows,
  displayTitles,
  mode,
  display,
  focusedIssueId,
  activeSessionId,
  renameTarget,
  isFolded,
  onToggle,
  onSelectIssue,
  onSelectSession,
  onIssueMenu,
  onStatusPick,
  onRenameIssue,
  onRenameDone,
}: FlightDeckWaterfallProps): JSX.Element {
  const projected = useMemo<WaterfallIssueRow[]>(
    () => [
      {
        row: rootRow,
        displayTitle: displayTitles.get(rootRow.issue.id) ?? rootRow.issue.title,
        sessions: deckSessions(rootRow, mode),
        root: true,
      },
      ...rows.map((row) => ({
        row,
        displayTitle: displayTitles.get(row.issue.id) ?? row.issue.title,
        sessions: deckSessions(row, mode),
        root: false,
      })),
    ],
    [displayTitles, mode, rootRow, rows],
  )
  const sessions = useMemo(() => projected.flatMap((item) => item.sessions), [projected])
  const timelineStart = useMemo(() => waterfallTimelineStart(sessions), [sessions])
  return (
    <div
      className={cn('flight-waterfall', display === 'expanded' && 'flight-waterfall-expanded')}
      data-testid="flight-deck-waterfall"
      data-display={display}
    >
      <WaterfallAxis timelineStart={timelineStart} />
      <div className="waterfall-rows" data-testid="flight-deck-rows">
        {projected.map((item) => (
          <WaterfallIssue
            key={item.row.issue.id}
            item={item}
            timelineStart={timelineStart}
            focused={focusedIssueId === item.row.issue.id}
            activeSessionId={activeSessionId}
            renameSeed={renameTarget?.id === item.row.issue.id ? renameTarget.seed : null}
            folded={isFolded(item.row)}
            onToggle={() => onToggle(item.row)}
            onSelectIssue={(permanent) => onSelectIssue(item.row, permanent)}
            onSelectSession={(session, permanent) =>
              onSelectSession(item.row.issue.id, session, { permanent })
            }
            onSelectNative={(session) =>
              onSelectSession(item.row.issue.id, session, { permanent: false, native: true })
            }
            onIssueMenu={(event) => onIssueMenu(item.row.issue.id, event)}
            onStatusPick={(value) => onStatusPick(item.row.issue.id, value)}
            onRenameIssue={(title) =>
              onRenameIssue(item.row.issue.id, title, renameTarget?.seed ?? item.displayTitle)
            }
            onRenameDone={onRenameDone}
          />
        ))}
      </div>
    </div>
  )
}
