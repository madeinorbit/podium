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
import { ChevronDown, ChevronRight, Crosshair, Ellipsis, Maximize, Minus, Plus } from 'lucide-react'
import type {
  CSSProperties,
  JSX,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { SessionContextMenu } from '@/lib/SessionContextMenu'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { cn } from '@/lib/utils'
import { KindIcon, SessionNameEditor, sessionDisplayName } from '@/lib/WorkerLabel'
import { useClickIntent } from './click-intent'
import type { FlightDeckDisplay } from './flight-deck-display'
import {
  fitWaterfallViewport,
  foldWaterfallSegments,
  formatWaterfallClock,
  formatWaterfallDuration,
  panWaterfallViewport,
  summarizeWaterfallSegments,
  WATERFALL_MIN_SPAN_MS,
  type WaterfallActivitySample,
  type WaterfallSegment,
  type WaterfallSessionState,
  type WaterfallViewport,
  waterfallBarGeometry,
  waterfallLabelPlacement,
  waterfallPercent,
  waterfallSegments,
  waterfallSessionEnd,
  waterfallSessionStart,
  waterfallSessionState,
  waterfallTicks,
  waterfallTimelineStart,
  zoomWaterfallViewport,
} from './flight-deck-waterfall'
import { clearHoveredSession, setHoveredSession, useSessionHovered } from './session-hover'
import { useStoreSelector } from './store'

interface WaterfallIssueRow {
  row: FlightDeckRow
  displayTitle: string
  sessions: SessionMeta[]
  root: boolean
}

interface WaterfallFuture {
  label: string
  detail?: string
  state: 'attention' | 'blocked' | 'future'
}

/** Everything a lane needs to project time onto pixels, computed once. */
interface WaterfallFrame {
  viewport: WaterfallViewport
  now: number
  trackPx: number
  msPerPx: number
  nowPct: number
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

function issueFuture(row: FlightDeckRow): WaterfallFuture | null {
  const issue = row.issue
  const question = issue.humanQuestion?.trim()
  if (question) return { label: 'Needs you', detail: question, state: 'attention' }
  const blocked = issue.blockedByNotes?.map((note) => note.trim()).find(Boolean)
  if (blocked) return { label: 'Blocked', detail: blocked, state: 'blocked' }
  const dependency = issue.dependencyNote?.trim()
  if (dependency) return { label: 'Waiting', detail: dependency, state: 'blocked' }
  if (issue.stage === 'proposed')
    return { label: 'Known next step', detail: 'Unassigned', state: 'future' }
  if (row.sessions.length === 0 && issue.stage !== 'done')
    return { label: 'Unassigned', state: 'future' }
  return null
}

function sessionReason(row: FlightDeckRow, session: SessionMeta): string | null {
  const runtime = session.agentState?.need?.summary?.trim()
  if (runtime) return runtime
  if (!sessionAsksOnIssue(row.issue, session)) return null
  return row.issue.humanQuestion?.trim() || 'Waiting for operator'
}

/**
 * Per-crew phase history behind the segmented bars. Poll-based on purpose: the
 * store replicates no per-session history (see activity-history.ts server-side)
 * and a fetch keyed on the crew's phase fingerprint refreshes exactly when a
 * bar's shape could have changed. Absence — old servers, unreadable ids,
 * pruned history — degrades to the solid single-color bar.
 */
function useWaterfallActivity(
  sessions: readonly SessionMeta[],
): ReadonlyMap<string, WaterfallActivitySample[]> {
  const trpc = useStoreSelector((store) => store.trpc) as {
    sessions?: {
      activityHistory?: {
        query: (input: {
          sessionIds: string[]
        }) => Promise<{ sessions?: Record<string, Array<{ at: string; phase: string }>> }>
      }
    }
  }
  const idsKey = useMemo(
    () => [...new Set(sessions.map((session) => session.sessionId))].sort().join('\n'),
    [sessions],
  )
  const fingerprint = useMemo(
    () =>
      sessions
        .map((session) => `${session.sessionId}:${session.agentState?.phase ?? session.status}`)
        .sort()
        .join('\n'),
    [sessions],
  )
  const [samples, setSamples] = useState<ReadonlyMap<string, WaterfallActivitySample[]>>(
    () => new Map(),
  )
  const query = trpc.sessions?.activityHistory?.query
  // biome-ignore lint/correctness/useExhaustiveDependencies(fingerprint): a phase flip anywhere in the crew must refetch even though the ids are unchanged.
  useEffect(() => {
    if (!query || idsKey.length === 0) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const result = await query({ sessionIds: idsKey.split('\n') })
        if (cancelled) return
        const next = new Map<string, WaterfallActivitySample[]>()
        for (const [sessionId, list] of Object.entries(result.sessions ?? {})) {
          const parsed = list
            .map((sample) => ({ at: Date.parse(sample.at), phase: sample.phase }))
            .filter((sample) => Number.isFinite(sample.at))
          if (parsed.length > 0) next.set(sessionId, parsed)
        }
        setSamples(next)
      } catch {
        // History is an enhancement; the solid bar remains truthful without it.
      }
    }
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [query, idsKey, fingerprint])
  return samples
}

const WaterfallAxis = memo(function WaterfallAxis({
  frame,
  following,
  onZoom,
  onFit,
  onLive,
}: {
  frame: WaterfallFrame
  following: boolean
  onZoom: (factor: number) => void
  onFit: () => void
  onLive: () => void
}): JSX.Element {
  const nowVisible = frame.nowPct >= 0 && frame.nowPct <= 100
  // Half a label of clearance at either edge; centred labels clip otherwise.
  const edgePct = (1_500 / Math.max(1, frame.trackPx)) * 1
  const ticks = useMemo(() => {
    const all = waterfallTicks(frame.viewport, frame.trackPx).filter(
      (tick) => tick.pct > edgePct && tick.pct < 100 - edgePct,
    )
    if (!nowVisible) return all
    // The NOW chip outranks any wall-clock label it would sit on.
    return all.filter((tick) => (Math.abs(tick.pct - frame.nowPct) / 100) * frame.trackPx > 26)
  }, [edgePct, frame.nowPct, frame.trackPx, frame.viewport, nowVisible])
  const nowAtEdge = (frame.nowPct / 100) * frame.trackPx > frame.trackPx - 26
  return (
    <div className="waterfall-axis">
      <span className="waterfall-axis-title">
        <span className="waterfall-axis-title-full">Task</span>
        <span className="waterfall-axis-controls">
          <button
            data-pressable
            type="button"
            aria-label="Zoom out"
            title="Zoom out (-)"
            onClick={() => onZoom(1.6)}
          >
            <Minus size={10} aria-hidden="true" />
          </button>
          <button
            data-pressable
            type="button"
            aria-label="Zoom in"
            title="Zoom in (+)"
            onClick={() => onZoom(1 / 1.6)}
          >
            <Plus size={10} aria-hidden="true" />
          </button>
          <button
            data-pressable
            type="button"
            aria-label="Fit timeline to all work"
            title="Fit all (0)"
            onClick={onFit}
          >
            <Maximize size={10} aria-hidden="true" />
          </button>
        </span>
      </span>
      <div className="waterfall-axis-track" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick.at} className="waterfall-axis-tick" style={{ left: `${tick.pct}%` }}>
            {tick.label}
          </span>
        ))}
        {nowVisible ? (
          <span
            className="waterfall-axis-now"
            data-edge={nowAtEdge || undefined}
            style={{ left: `${frame.nowPct}%` }}
          >
            now
          </span>
        ) : null}
        {!following || !nowVisible ? (
          <button
            data-pressable
            type="button"
            className="waterfall-live-resume"
            onClick={onLive}
            aria-label="Follow live time again"
          >
            <Crosshair size={9} aria-hidden="true" />
            live
          </button>
        ) : null}
      </div>
    </div>
  )
})

function segmentSpans(
  segments: readonly WaterfallSegment[],
  startMs: number,
  endMs: number,
): Array<{ key: number; leftPct: number; widthPct: number; kind: WaterfallSegment['kind'] }> {
  const total = Math.max(1, endMs - startMs)
  return segments.map((segment) => ({
    key: segment.start,
    leftPct: ((segment.start - startMs) / total) * 100,
    widthPct: ((segment.end - segment.start) / total) * 100,
    kind: segment.kind,
  }))
}

function WaterfallHoverCard({
  session,
  state,
  startMs,
  endMs,
  live,
  segments,
  reason,
  workers,
  coordinator,
  unread,
}: {
  session: SessionMeta
  state: WaterfallSessionState
  startMs: number
  endMs: number
  live: boolean
  segments: readonly WaterfallSegment[]
  reason: string | null
  workers: number
  coordinator: boolean
  unread: boolean
}): JSX.Element {
  const name = sessionDisplayName(session)
  const ref = session.displayRef?.trim()
  const summary = useMemo(() => summarizeWaterfallSegments(segments), [segments])
  const stateLine =
    state === 'finished'
      ? `Finished ${formatWaterfallClock(endMs)}`
      : state === 'working'
        ? 'Working now'
        : state === 'attention'
          ? 'Needs you'
          : 'Live, standing by'
  const totalWorked = summary.workingMs > 0 ? summary.workingMs : session.agentState?.workingMsTotal
  return (
    <div className="waterfall-hover-card">
      <div className="waterfall-hover-head">
        <KindIcon kind={session.agentKind} compact />
        <strong>{name}</strong>
        {ref ? <span className="waterfall-hover-ref">{ref}</span> : null}
      </div>
      <div className="waterfall-hover-line" data-state={state}>
        {stateLine}
        {coordinator ? ' · coordinator' : ''}
        {unread ? ' · unread' : ''}
      </div>
      <div className="waterfall-hover-line">
        {formatWaterfallClock(startMs)} → {live ? 'now' : formatWaterfallClock(endMs)} ·{' '}
        {formatWaterfallDuration(endMs - startMs)} elapsed
      </div>
      {segments.length > 0 ? (
        <div className="waterfall-hover-line">
          {summary.workingStretches} work stretch{summary.workingStretches === 1 ? '' : 'es'} ·{' '}
          {formatWaterfallDuration(summary.workingMs)} working
          {summary.idleMs > 60_000 ? ` · ${formatWaterfallDuration(summary.idleMs)} waiting` : ''}
          {summary.attentionMs > 60_000
            ? ` · ${formatWaterfallDuration(summary.attentionMs)} on you`
            : ''}
        </div>
      ) : totalWorked && totalWorked > 0 ? (
        <div className="waterfall-hover-line">
          {formatWaterfallDuration(totalWorked)} worked in total
        </div>
      ) : null}
      {reason ? <div className="waterfall-hover-reason">{reason}</div> : null}
      {workers > 0 ? (
        <div className="waterfall-hover-line">
          {workers} native worker{workers === 1 ? '' : 's'} active
        </div>
      ) : null}
    </div>
  )
}

const WaterfallSessionBar = memo(function WaterfallSessionBar({
  row,
  session,
  frame,
  samples,
  selected,
  flashed,
  onOpen,
  onOpenNative,
  onLocalPick,
}: {
  row: FlightDeckRow
  session: SessionMeta
  frame: WaterfallFrame
  samples: readonly WaterfallActivitySample[] | undefined
  selected: boolean
  flashed: boolean
  onOpen: (permanent: boolean) => void
  onOpenNative: () => void
  onLocalPick: () => void
}): JSX.Element {
  const intent = useClickIntent()
  const renameSession = useStoreSelector((store) => store.renameSession)
  const startMs = waterfallSessionStart(session, frame.now)
  const endMs = Math.max(startMs, waterfallSessionEnd(session, frame.now))
  const state = (() => {
    const asking = sessionAsksOnIssue(row.issue, session)
    return asking ? 'attention' : waterfallSessionState(session)
  })()
  const live = state !== 'finished'
  const geometry = waterfallBarGeometry(startMs, endMs, frame.viewport)
  const segments = useMemo(() => {
    if (!samples || samples.length === 0) return []
    return foldWaterfallSegments(waterfallSegments(samples, startMs, endMs), frame.msPerPx)
  }, [samples, startMs, endMs, frame.msPerPx])
  const reason = sessionReason(row, session)
  const name = sessionDisplayName(session)
  const coordinator = isCoordinatorSession(row.issue, session.sessionId)
  const workers = useMemo(() => nativeSubagentRows(session), [session])
  const pointed = useSessionHovered(session.sessionId)
  const unread = sessionUnreadEmphasized(session)
  const [nativeOpen, setNativeOpen] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  const nativeListId = useId()

  const barLeftPx = (geometry.leftPct / 100) * frame.trackPx
  const barWidthPx = (geometry.widthPct / 100) * frame.trackPx
  const placement = waterfallLabelPlacement(barLeftPx, barWidthPx, frame.trackPx)
  // A chip with no room renders as a clipped word; the bar's attention state
  // already carries the signal, so the chip yields below ~56px of track.
  const reasonRoomPx = frame.trackPx - (barLeftPx + barWidthPx)
  const showReasonChip = reason !== null && reasonRoomPx >= 56
  // The needs-you chip owns the space after the bar; the name yields to it.
  const labelPlacementFinal = showReasonChip && placement === 'after' ? 'none' : placement
  const showDuration = barWidthPx >= 132 && labelPlacementFinal === 'inside'

  const openMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenuAnchor({ x: event.clientX || rect.right, y: event.clientY || rect.bottom })
  }
  const label = [
    session.displayRef?.trim(),
    name,
    coordinator ? 'coordinator' : null,
    reason,
    unread ? 'unread' : null,
    workers.length > 0
      ? `${workers.length} active native worker${workers.length === 1 ? '' : 's'}`
      : null,
    formatWaterfallDuration(endMs - startMs),
    state === 'finished' ? 'finished' : state === 'working' ? 'working now' : 'live',
  ]
    .filter(Boolean)
    .join(' · ')

  if (!geometry.visible) {
    // The bar lies entirely outside the zoomed frame: keep the lane and leave
    // an edge marker that names and reveals it instead of silently dropping it.
    const side = geometry.clippedStart && geometry.widthPct === 0 && geometry.leftPct === 0
    return (
      <div className="waterfall-session-lane" data-offscreen="true">
        <button
          data-pressable
          type="button"
          className="waterfall-offscreen"
          data-side={side ? 'start' : 'end'}
          data-flight-session={session.sessionId}
          title={`${name} · outside the current zoom`}
          aria-label={`${name} is outside the visible time range`}
          onClick={() => {
            onLocalPick()
            onOpen(false)
          }}
        >
          {side ? '‹' : '›'}
        </button>
      </div>
    )
  }

  const geometryStyle = {
    '--waterfall-left': `${geometry.leftPct}%`,
    '--waterfall-width': `${geometry.widthPct}%`,
  } as CSSProperties

  return (
    <div
      className="waterfall-session-lane"
      data-pointed={pointed || undefined}
      data-unread={unread || undefined}
      data-has-native={workers.length > 0 || undefined}
      style={geometryStyle}
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
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  data-pressable
                  type="button"
                  className="waterfall-session-bar"
                  data-flight-session={session.sessionId}
                  data-state={state}
                  data-selected={selected || undefined}
                  data-flash={flashed || undefined}
                  data-clipped-start={geometry.clippedStart || undefined}
                  data-pointed={pointed || undefined}
                  data-unread={unread || undefined}
                  data-coordinator={coordinator || undefined}
                  data-segmented={segments.length > 0 || undefined}
                  data-live={live || undefined}
                  aria-label={label}
                  aria-pressed={selected}
                  onPointerEnter={() => setHoveredSession(session.sessionId)}
                  onPointerLeave={() => clearHoveredSession(session.sessionId)}
                  onClick={() => {
                    onLocalPick()
                    intent.press(
                      () => onOpen(false),
                      () => onOpen(true),
                    )
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    onLocalPick()
                    intent.commit(() => onOpen(true))
                  }}
                  onContextMenu={openMenu}
                />
              }
            >
              {segments.length > 0 ? (
                <span className="waterfall-seg-layer" aria-hidden="true">
                  {segmentSpans(segments, startMs, endMs).map((span) => (
                    <span
                      key={span.key}
                      className="waterfall-seg"
                      data-kind={span.kind}
                      style={{ left: `${span.leftPct}%`, width: `${span.widthPct}%` }}
                    />
                  ))}
                </span>
              ) : null}
              {labelPlacementFinal === 'inside' ? (
                <span className="waterfall-bar-content">
                  <KindIcon kind={session.agentKind} compact dimmed={state === 'finished'} />
                  <span className="waterfall-session-name">{name}</span>
                  {showDuration ? (
                    <span className="waterfall-session-time font-mono tabular-nums">
                      {formatWaterfallDuration(endMs - startMs)}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {/* The unread mark survives every label ladder rung: a bar too
                  narrow for its name still owes the operator this one bit. */}
              {unread ? (
                <>
                  <span className="waterfall-unread-dot" aria-hidden="true" />
                  <span className="sr-only">unread</span>
                </>
              ) : null}
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="waterfall-hover-content">
              <WaterfallHoverCard
                session={session}
                state={state}
                startMs={startMs}
                endMs={endMs}
                live={live}
                segments={segments}
                reason={reason}
                workers={workers.length}
                coordinator={coordinator}
                unread={unread}
              />
            </TooltipContent>
          </Tooltip>
          {labelPlacementFinal === 'after' || labelPlacementFinal === 'before' ? (
            <span
              className="waterfall-bar-tag"
              data-side={labelPlacementFinal}
              data-state={state}
              aria-hidden="true"
            >
              {name}
              <span className="waterfall-bar-tag-time font-mono tabular-nums">
                {formatWaterfallDuration(endMs - startMs)}
              </span>
            </span>
          ) : null}
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
      {showReasonChip && reason ? (
        <span
          role="note"
          className="waterfall-wait-reason"
          title={reason}
          aria-label={`Needs you: ${reason}`}
        >
          <strong>Needs you</strong>
          <span>{reason}</span>
        </span>
      ) : null}
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

const WaterfallHistorySummary = memo(function WaterfallHistorySummary({
  sessions,
  frame,
  expanded,
  onToggle,
}: {
  sessions: readonly SessionMeta[]
  frame: WaterfallFrame
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const bounds = useMemo(() => {
    let startedAt = frame.now
    let endedAt = frame.viewport.start
    for (const session of sessions) {
      startedAt = Math.min(startedAt, waterfallSessionStart(session, frame.now))
      endedAt = Math.max(endedAt, waterfallSessionEnd(session, frame.now))
    }
    return { startedAt, endedAt }
  }, [frame.now, frame.viewport.start, sessions])
  const geometry = waterfallBarGeometry(bounds.startedAt, bounds.endedAt, frame.viewport)
  const count = sessions.length
  const label = `${count} completed session${count === 1 ? '' : 's'} · ${formatWaterfallDuration(
    Math.max(0, bounds.endedAt - bounds.startedAt),
  )} span`
  return (
    <div
      className="waterfall-session-lane waterfall-history-lane"
      style={
        {
          '--waterfall-left': `${geometry.leftPct}%`,
          '--waterfall-width': `${Math.max(geometry.widthPct, 2)}%`,
        } as CSSProperties
      }
    >
      <button
        data-pressable
        type="button"
        className="waterfall-session-bar waterfall-history-summary"
        data-open={expanded || undefined}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
        title={label}
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown size={10} aria-hidden="true" />
        ) : (
          <ChevronRight size={10} aria-hidden="true" />
        )}
        <span className="waterfall-session-name">{count} completed</span>
        <span className="waterfall-session-time font-mono tabular-nums">
          {formatWaterfallDuration(Math.max(0, bounds.endedAt - bounds.startedAt))}
        </span>
      </button>
    </div>
  )
})

const WaterfallIssue = memo(function WaterfallIssue({
  item,
  frame,
  activity,
  focused,
  activeSessionId,
  flashSessionId,
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
  onLocalPick,
}: {
  item: WaterfallIssueRow
  frame: WaterfallFrame
  activity: ReadonlyMap<string, WaterfallActivitySample[]>
  focused: boolean
  activeSessionId: string | null
  flashSessionId: string | null
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
  onLocalPick: (sessionId: string) => void
}): JSX.Element {
  const intent = useClickIntent()
  const [historyOpen, setHistoryOpen] = useState(false)
  const future = issueFuture(item.row)
  const foldable = !item.root && (item.row.descendantIds.length > 0 || item.row.sessions.length > 0)
  const indent = item.root ? 0 : Math.max(0, item.row.depth - 1)
  const issueRef = issueDisplayRef(item.row.issue)
  const coordinator = item.sessions.find((session) =>
    isCoordinatorSession(item.row.issue, session.sessionId),
  )
  const sessionCount = item.sessions.length
  const issueTitle =
    item.root && item.row.descendantIds.length > 0 ? 'Mission coordination' : item.displayTitle
  const issueMeta = [
    issueRef,
    sessionCount > 0 ? `${sessionCount} session${sessionCount === 1 ? '' : 's'}` : null,
    coordinator ? sessionDisplayName(coordinator) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const foldedHistory = useMemo(
    () =>
      item.sessions.filter(
        (session) =>
          waterfallSessionState(session) === 'finished' &&
          !isCoordinatorSession(item.row.issue, session.sessionId) &&
          session.sessionId !== activeSessionId,
      ),
    [activeSessionId, item.row.issue, item.sessions],
  )
  const historyCollapsed = foldedHistory.length > 3
  const foldedIds = useMemo(
    () => new Set(foldedHistory.map((session) => session.sessionId)),
    [foldedHistory],
  )
  const visibleSessions =
    historyCollapsed && !historyOpen
      ? item.sessions.filter((session) => !foldedIds.has(session.sessionId))
      : item.sessions
  return (
    <div
      className="waterfall-issue-row"
      data-flight-issue={item.row.issue.id}
      data-depth={item.row.depth}
      data-focused={focused || undefined}
      style={{ '--waterfall-depth': indent } as CSSProperties}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click convenience; the same menu hangs on the cell's real button. */}
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
            title={`${issueRef} · ${item.displayTitle}`}
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
            <span className="waterfall-issue-title">{issueTitle}</span>
            <span className="waterfall-issue-meta font-mono">{issueMeta}</span>
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
          <>
            {historyCollapsed ? (
              <WaterfallHistorySummary
                sessions={foldedHistory}
                frame={frame}
                expanded={historyOpen}
                onToggle={() => setHistoryOpen((open) => !open)}
              />
            ) : null}
            {visibleSessions.map((session) => (
              <WaterfallSessionBar
                key={session.sessionId}
                row={item.row}
                session={session}
                frame={frame}
                samples={activity.get(session.sessionId)}
                selected={session.sessionId === activeSessionId}
                flashed={session.sessionId === flashSessionId}
                onOpen={(permanent) => onSelectSession(session, permanent)}
                onOpenNative={() => onSelectNative(session)}
                onLocalPick={() => onLocalPick(session.sessionId)}
              />
            ))}
          </>
        ) : future ? (
          <span
            role="note"
            className="waterfall-future-label"
            data-state={future.state}
            title={[future.label, future.detail].filter(Boolean).join(': ')}
            aria-label={[future.label, future.detail].filter(Boolean).join(': ')}
          >
            <strong>{future.label}</strong>
            {future.detail ? <span>{future.detail}</span> : null}
          </span>
        ) : null}
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
  const now = useStoreSelector((store) => store.coarseNow)
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
  const activity = useWaterfallActivity(sessions)
  const timelineStart = useMemo(() => waterfallTimelineStart(sessions), [sessions])
  const hasFuture = useMemo(
    () => projected.some((item) => item.sessions.length === 0 && issueFuture(item.row) !== null),
    [projected],
  )

  const [manual, setManual] = useState<WaterfallViewport | null>(null)
  const [flashSessionId, setFlashSessionId] = useState<string | null>(null)
  const viewport = manual ?? fitWaterfallViewport(timelineStart, now, { future: hasFuture })

  const rootRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [trackPx, setTrackPx] = useState(240)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const probe = root.querySelector('.waterfall-axis-track')
    if (!(probe instanceof HTMLElement)) return
    trackRef.current = probe as HTMLDivElement
    const observer = new ResizeObserver(() => {
      setTrackPx(Math.max(60, probe.clientWidth))
    })
    observer.observe(probe)
    setTrackPx(Math.max(60, probe.clientWidth))
    return () => observer.disconnect()
  }, [])

  // The sticky axis parks directly under the deck's sticky mission chrome,
  // whose height changes with column width and header wrap. Measured from in
  // here — not in FlightDeck — so the observer exists only while the waterfall
  // does, and the offset var lives on the shared scroller both stickies use.
  useEffect(() => {
    const scroller = rootRef.current?.closest('[data-testid="flight-deck-scroller"]')
    const chrome = scroller?.querySelector('.deck-chrome')
    if (!(scroller instanceof HTMLElement) || !(chrome instanceof HTMLElement)) return
    const apply = (): void => {
      scroller.style.setProperty('--waterfall-chrome-offset', `${chrome.offsetHeight}px`)
    }
    const observer = new ResizeObserver(apply)
    observer.observe(chrome)
    apply()
    return () => {
      observer.disconnect()
      scroller.style.removeProperty('--waterfall-chrome-offset')
    }
  }, [])

  const frame = useMemo<WaterfallFrame>(() => {
    const span = viewport.end - viewport.start
    return {
      viewport,
      now,
      trackPx,
      msPerPx: trackPx > 0 ? span / trackPx : 60_000,
      nowPct: waterfallPercent(viewport, now),
    }
  }, [now, trackPx, viewport])

  // Refs for the stable wheel listener (non-passive, so it can preventDefault).
  const frameRef = useRef(frame)
  frameRef.current = frame
  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const onWheel = (event: WheelEvent): void => {
      const current = frameRef.current
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const track = trackRef.current
        const rect = track?.getBoundingClientRect()
        const fraction = rect
          ? Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
          : 0.5
        const factor = Math.exp(event.deltaY * 0.002)
        setManual(zoomWaterfallViewport(current.viewport, factor, fraction, current.now))
        return
      }
      const horizontal = event.shiftKey
        ? event.deltaY || event.deltaX
        : Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : 0
      if (horizontal !== 0) {
        event.preventDefault()
        setManual(panWaterfallViewport(current.viewport, horizontal * current.msPerPx, current.now))
      }
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  // Drag-to-pan on empty track space; clicks on bars and buttons stay clicks.
  const dragRef = useRef<{ x: number; viewport: WaterfallViewport; moved: boolean } | null>(null)
  const onTrackPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (!target.closest('.waterfall-track-cell')) return
    if (target.closest('button, input, a, [data-pressable]')) return
    dragRef.current = { x: event.clientX, viewport: frameRef.current.viewport, moved: false }
  }, [])
  const onTrackPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    if (!drag.moved && Math.abs(dx) < 4) return
    drag.moved = true
    event.currentTarget.setPointerCapture(event.pointerId)
    setManual(
      panWaterfallViewport(drag.viewport, -dx * frameRef.current.msPerPx, frameRef.current.now),
    )
  }, [])
  const onTrackPointerUp = useCallback((): void => {
    dragRef.current = null
  }, [])
  const onTrackDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (!target.closest('.waterfall-track-cell')) return
    if (target.closest('button, input, a, [data-pressable]')) return
    setManual(null)
  }, [])

  const zoomBy = useCallback((factor: number): void => {
    const current = frameRef.current
    const anchor = Math.min(1, Math.max(0, current.nowPct / 100))
    setManual(zoomWaterfallViewport(current.viewport, factor, anchor, current.now))
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable="true"]')) return
      const current = frameRef.current
      const span = current.viewport.end - current.viewport.start
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomBy(1 / 1.6)
      } else if (event.key === '-') {
        event.preventDefault()
        zoomBy(1.6)
      } else if (event.key === '0') {
        event.preventDefault()
        setManual(null)
      } else if (event.key === 'ArrowLeft' && event.altKey) {
        event.preventDefault()
        setManual(panWaterfallViewport(current.viewport, -span * 0.2, current.now))
      } else if (event.key === 'ArrowRight' && event.altKey) {
        event.preventDefault()
        setManual(panWaterfallViewport(current.viewport, span * 0.2, current.now))
      }
    },
    [zoomBy],
  )

  // TAB AREA → WATERFALL. `activeSessionId` follows the workspace's focused
  // session tab through the store mirror; when the change did not start with a
  // click in here, walk to the bar: scroll its lane into view, flash it, and —
  // under a manual zoom that excludes it — pan the frame to its interval.
  const localPickRef = useRef<string | null>(null)
  const onLocalPick = useCallback((sessionId: string): void => {
    localPickRef.current = sessionId
  }, [])
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const manualRef = useRef(manual)
  manualRef.current = manual
  useEffect(() => {
    if (!activeSessionId) return
    if (localPickRef.current === activeSessionId) {
      localPickRef.current = null
      return
    }
    const session = sessionsRef.current.find((item) => item.sessionId === activeSessionId)
    if (!session) return
    const current = manualRef.current
    if (current) {
      const start = waterfallSessionStart(session, frameRef.current.now)
      const end = Math.max(start, waterfallSessionEnd(session, frameRef.current.now))
      const visibleFrom = Math.max(start, current.start)
      const visibleTo = Math.min(end, current.end)
      const coverage = (visibleTo - visibleFrom) / Math.max(1, end - start)
      if (coverage < 0.5) {
        const span = Math.max(WATERFALL_MIN_SPAN_MS, (end - start) * 1.5)
        const mid = (start + end) / 2
        setManual(
          panWaterfallViewport(
            { start: mid - span / 2, end: mid + span / 2 },
            0,
            frameRef.current.now,
          ),
        )
      }
    }
    const timer = setTimeout(() => {
      const bar = rootRef.current?.querySelector(
        `[data-flight-session="${CSS.escape(activeSessionId)}"]`,
      )
      bar?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 30)
    setFlashSessionId(activeSessionId)
    const flashTimer = setTimeout(() => setFlashSessionId(null), 1_600)
    return () => {
      clearTimeout(timer)
      clearTimeout(flashTimer)
    }
  }, [activeSessionId])

  useEffect(() => {
    if (!focusedIssueId) return
    const row = rootRef.current?.querySelector(
      `[data-flight-issue="${CSS.escape(focusedIssueId)}"]`,
    )
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusedIssueId])

  const nowInFrame = frame.nowPct >= 0 && frame.nowPct <= 100
  return (
    <TooltipProvider delay={140}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: zoom/pan gesture surface; every action here also has a real button or key. */}
      <div
        ref={rootRef}
        className={cn('flight-waterfall', display === 'expanded' && 'flight-waterfall-expanded')}
        data-testid="flight-deck-waterfall"
        data-display={display}
        data-following={manual === null || undefined}
        style={{ '--waterfall-now': `${frame.nowPct}%` } as CSSProperties}
        onKeyDown={onKeyDown}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerUp}
        onDoubleClick={onTrackDoubleClick}
      >
        <WaterfallAxis
          frame={frame}
          following={manual === null}
          onZoom={zoomBy}
          onFit={() => setManual(null)}
          onLive={() => setManual(null)}
        />
        {nowInFrame ? <div className="waterfall-now-line" aria-hidden="true" /> : null}
        <div className="waterfall-rows" data-testid="flight-deck-rows">
          {projected.map((item) => (
            <WaterfallIssue
              key={item.row.issue.id}
              item={item}
              frame={frame}
              activity={activity}
              focused={focusedIssueId === item.row.issue.id}
              activeSessionId={activeSessionId}
              flashSessionId={flashSessionId}
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
              onLocalPick={onLocalPick}
            />
          ))}
        </div>
      </div>
    </TooltipProvider>
  )
}
