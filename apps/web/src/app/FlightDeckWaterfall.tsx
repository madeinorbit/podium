import {
  deckSessions,
  type FlightDeckMode,
  type FlightDeckRow,
  isCoordinatorSession,
  sessionAsksOnIssue,
} from '@podium/client-core/viewmodels'
import type { IssueId, SessionMeta } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { ChevronDown, ChevronRight, Ellipsis } from 'lucide-react'
import type { CSSProperties, JSX, MouseEvent as ReactMouseEvent } from 'react'
import { memo, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { KindIcon, SessionNameEditor, sessionDisplayName } from '@/lib/WorkerLabel'
import { cn } from '@/lib/utils'
import { useClickIntent } from './click-intent'
import { useStoreSelector } from './store'
import type { FlightDeckDisplay } from './flight-deck-display'
import {
  buildWaterfallTimeline,
  formatWaterfallDuration,
  waterfallAxisTicks,
  waterfallInterval,
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
  onSelectSession: (issueId: IssueId, session: SessionMeta, permanent: boolean) => void
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

function SessionElapsed({
  session,
  startedAt,
}: {
  session: SessionMeta
  startedAt: number
}): JSX.Element {
  // Only live bar readouts subscribe to the shared minute clock. The indexed
  // mission rows and interval geometry stay memoized and do not rerender on a
  // timer tick.
  const now = useStoreSelector((store) => store.coarseNow)
  const end =
    session.status === 'exited' || session.archived
      ? Date.parse(session.stoppedAt ?? session.lastActiveAt)
      : now
  return <span>{formatWaterfallDuration(Math.max(0, end - startedAt))}</span>
}

const WaterfallSessionBar = memo(function WaterfallSessionBar({
  row,
  session,
  timeline,
  selected,
  onOpen,
}: {
  row: FlightDeckRow
  session: SessionMeta
  timeline: ReturnType<typeof buildWaterfallTimeline>
  selected: boolean
  onOpen: (permanent: boolean) => void
}): JSX.Element {
  const intent = useClickIntent()
  const interval = waterfallInterval(session, timeline)
  const asking = sessionAsksOnIssue(row.issue, session)
  const state = asking ? 'attention' : interval.state
  const reason = sessionReason(row, session)
  const name = sessionDisplayName(session)
  const ref = session.displayRef?.trim()
  const coordinator = isCoordinatorSession(row.issue, session.sessionId)
  const workers = session.agentState?.nativeSubagentCount ?? 0
  const label = [
    ref,
    name,
    coordinator ? 'coordinator' : null,
    reason,
    workers > 0 ? `${workers} active native worker${workers === 1 ? '' : 's'}` : null,
    formatWaterfallDuration(interval.end - interval.start),
    state === 'finished' ? 'finished' : state === 'working' ? 'working now' : 'live',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="waterfall-session-lane">
      <button
        data-pressable
        type="button"
        className="waterfall-session-bar"
        data-flight-session={session.sessionId}
        data-state={state}
        data-selected={selected || undefined}
        data-clipped-start={interval.clippedStart || undefined}
        aria-label={label}
        aria-pressed={selected}
        style={
          {
            '--waterfall-left': `${interval.left}%`,
            '--waterfall-width': `${interval.width}%`,
          } as CSSProperties
        }
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
      >
        <KindIcon kind={session.agentKind} compact dimmed={state === 'finished'} />
        <span className="waterfall-session-name">{name}</span>
        {workers > 0 ? (
          <span className="waterfall-native-count" aria-label={`${workers} active native workers`}>
            +{workers}
          </span>
        ) : null}
        <span className="waterfall-session-time font-mono tabular-nums">
          {state === 'finished' ? (
            formatWaterfallDuration(interval.end - interval.start)
          ) : (
            <SessionElapsed session={session} startedAt={interval.start} />
          )}
        </span>
      </button>
      {reason ? <span className="waterfall-wait-reason">{reason}</span> : null}
    </div>
  )
})

const WaterfallIssue = memo(function WaterfallIssue({
  item,
  timeline,
  focused,
  activeSessionId,
  renameSeed,
  folded,
  onToggle,
  onSelectIssue,
  onSelectSession,
  onIssueMenu,
  onStatusPick,
  onRenameIssue,
  onRenameDone,
}: {
  item: WaterfallIssueRow
  timeline: ReturnType<typeof buildWaterfallTimeline>
  focused: boolean
  activeSessionId: string | null
  renameSeed: string | null
  folded: boolean
  onToggle: () => void
  onSelectIssue: (permanent: boolean) => void
  onSelectSession: (session: SessionMeta, permanent: boolean) => void
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
              timeline={timeline}
              selected={session.sessionId === activeSessionId}
              onOpen={(permanent) => onSelectSession(session, permanent)}
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
  const timeline = useMemo(() => buildWaterfallTimeline(sessions, Date.now()), [sessions])
  const ticks = useMemo(() => waterfallAxisTicks(timeline), [timeline])
  return (
    <div
      className={cn('flight-waterfall', display === 'expanded' && 'flight-waterfall-expanded')}
      data-testid="flight-deck-waterfall"
      data-display={display}
    >
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
      <div className="waterfall-rows" data-testid="flight-deck-rows">
        {projected.map((item) => (
          <WaterfallIssue
            key={item.row.issue.id}
            item={item}
            timeline={timeline}
            focused={focusedIssueId === item.row.issue.id}
            activeSessionId={activeSessionId}
            renameSeed={renameTarget?.id === item.row.issue.id ? renameTarget.seed : null}
            folded={isFolded(item.row)}
            onToggle={() => onToggle(item.row)}
            onSelectIssue={(permanent) => onSelectIssue(item.row, permanent)}
            onSelectSession={(session, permanent) =>
              onSelectSession(item.row.issue.id, session, permanent)
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
