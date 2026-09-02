import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import {
  FLIGHT_DECK_WATERFALL_ROW_ZOOM_KEY,
  FLIGHT_DECK_WATERFALL_TASK_WIDTH_KEY,
} from '@podium/client-core/ui-state'
import {
  deckSessions,
  type FlightDeckMode,
  type FlightDeckRow,
  isCoordinatorSession,
  nativeSubagentRows,
  sessionAsksOnIssue,
  sessionSettled,
  sessionUnreadEmphasized,
} from '@podium/client-core/viewmodels'
import type { IssueId, SessionMeta } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Maximize,
  Minus,
  MoveVertical,
  Plus,
} from 'lucide-react'
import type {
  CSSProperties,
  JSX,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Tooltip, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { SessionContextMenu } from '@/lib/SessionContextMenu'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { cn } from '@/lib/utils'
import { KindIcon, SessionNameEditor, sessionDisplayName } from '@/lib/WorkerLabel'
import { useClickIntent } from './click-intent'
import type { FlightDeckDisplay } from './flight-deck-display'
import {
  fitWaterfallViewport,
  followWaterfallViewport,
  foldWaterfallSegments,
  formatWaterfallClock,
  formatWaterfallDuration,
  panWaterfallViewport,
  summarizeWaterfallSegments,
  WATERFALL_MIN_SPAN_MS,
  type WaterfallActivitySample,
  type WaterfallSegment,
  type WaterfallSessionState,
  type WaterfallTick,
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

const WATERFALL_ROW_ZOOM_MIN = 0.72
const WATERFALL_ROW_ZOOM_MAX = 1.55
const WATERFALL_ROW_ZOOM_STEP = 0.08
const WATERFALL_AXIS_HEIGHT = 32
const WATERFALL_TASK_WIDTH_MIN = 168
const WATERFALL_TASK_WIDTH_MAX = 300
const WATERFALL_TRACK_WIDTH_MIN = 132
const WATERFALL_TASK_WIDTH_STEP = 12

export function clampWaterfallRowZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(WATERFALL_ROW_ZOOM_MAX, Math.max(WATERFALL_ROW_ZOOM_MIN, value))
}

function readWaterfallRowZoom(raw: string | null): number | null {
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? clampWaterfallRowZoom(parsed) : null
}

function writeWaterfallRowZoom(value: number | null): string | null {
  return value === null ? null : clampWaterfallRowZoom(value).toFixed(2)
}

function waterfallRowMetrics(zoom: number): {
  bar: number
  lane: number
  gap: number
  padding: number
} {
  return {
    bar: Math.round(Math.min(28, Math.max(15, 20 * zoom))),
    lane: Math.round(Math.min(34, Math.max(19, 24 * zoom))),
    gap: Math.round(Math.min(5, Math.max(1, 2 * zoom))),
    padding: Math.round(Math.min(7, Math.max(3, 4 * zoom))),
  }
}

/** Largest row scale whose initial lanes fit the visible part of the deck. */
export function defaultWaterfallRowZoom(
  availableHeight: number,
  laneCounts: readonly number[],
): number {
  if (availableHeight <= WATERFALL_AXIS_HEIGHT || laneCounts.length === 0) return 1
  const budget = availableHeight - WATERFALL_AXIS_HEIGHT
  const contentHeight = (zoom: number): number => {
    const metrics = waterfallRowMetrics(zoom)
    return laneCounts.reduce((total, rawCount) => {
      const count = Math.max(1, rawCount)
      const track = count * metrics.lane + Math.max(0, count - 1) * metrics.gap
      const issueDetails = 30 + metrics.padding * 2
      return total + Math.max(track + metrics.padding * 2, issueDetails) + 1
    }, 0)
  }
  if (contentHeight(WATERFALL_ROW_ZOOM_MAX) <= budget) return WATERFALL_ROW_ZOOM_MAX
  if (contentHeight(WATERFALL_ROW_ZOOM_MIN) >= budget) return WATERFALL_ROW_ZOOM_MIN
  let low = WATERFALL_ROW_ZOOM_MIN
  let high = WATERFALL_ROW_ZOOM_MAX
  for (let index = 0; index < 12; index += 1) {
    const middle = (low + high) / 2
    if (contentHeight(middle) <= budget) low = middle
    else high = middle
  }
  return Math.round(low * 100) / 100
}

function readWaterfallTaskWidth(raw: string | null): number | null {
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function writeWaterfallTaskWidth(value: number | null): string | null {
  return value === null ? null : String(Math.round(value))
}

export function clampWaterfallTaskWidth(value: number, rootWidth: number): number {
  const max =
    rootWidth > 0
      ? Math.max(
          WATERFALL_TASK_WIDTH_MIN,
          Math.min(WATERFALL_TASK_WIDTH_MAX, rootWidth - WATERFALL_TRACK_WIDTH_MIN),
        )
      : WATERFALL_TASK_WIDTH_MAX
  return Math.round(Math.min(max, Math.max(WATERFALL_TASK_WIDTH_MIN, value)))
}

/** Content-aware starting width with enough timeline left for useful bars. */
export function defaultWaterfallTaskWidth(
  titles: readonly string[],
  rootWidth: number,
  expanded: boolean,
): number {
  const longest = titles.reduce((length, title) => Math.max(length, [...title].length), 0)
  const titleRoom = Math.min(34, Math.max(18, longest)) * 6.1
  const desired = Math.max(expanded ? 214 : 188, 64 + titleRoom)
  const fallbackRootWidth = expanded ? 680 : 360
  return clampWaterfallTaskWidth(desired, rootWidth || fallbackRootWidth)
}

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
  onIssueMenu: (issueId: IssueId, anchor: ContextMenuAnchor) => void
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
  // The 60s poll usually returns exactly what it returned last time; replacing
  // the Map identity anyway would re-render every bar for nothing. A cheap
  // signature (id : count : last transition) catches the no-op case.
  const signatureRef = useRef('')
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
        const signature = [...next.entries()]
          .map(([id, list]) => `${id}:${list.length}:${list[list.length - 1]?.at ?? 0}`)
          .sort()
          .join('|')
        if (signature === signatureRef.current) return
        signatureRef.current = signature
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
  ticks,
  following,
  hasCurrentWork,
  rowZoom,
  automaticRowZoom,
  onZoom,
  onRowZoomPreview,
  onRowZoomCommit,
  onRowZoomReset,
  onFit,
  onFollow,
}: {
  frame: WaterfallFrame
  ticks: readonly WaterfallTick[]
  following: boolean
  hasCurrentWork: boolean
  rowZoom: number
  automaticRowZoom: boolean
  onZoom: (factor: number) => void
  onRowZoomPreview: (scale: number | null) => void
  onRowZoomCommit: (scale: number) => void
  onRowZoomReset: () => void
  onFit: () => void
  onFollow: () => void
}): JSX.Element {
  const nowVisible = frame.nowPct >= 0 && frame.nowPct <= 100
  const nowAtEdge = (frame.nowPct / 100) * frame.trackPx > frame.trackPx - 26
  const rowDragRef = useRef<{ y: number; zoom: number; pointerId: number } | null>(null)
  const setSteppedRowZoom = (direction: number): void => {
    onRowZoomCommit(clampWaterfallRowZoom(rowZoom + direction * WATERFALL_ROW_ZOOM_STEP))
  }
  return (
    <div className="waterfall-axis">
      <span className="waterfall-axis-title">
        <span className="waterfall-axis-title-full">Tasks</span>
        <span
          className="waterfall-row-zoom"
          role="slider"
          tabIndex={0}
          aria-label="Timeline row height"
          aria-orientation="vertical"
          aria-valuemin={Math.round(WATERFALL_ROW_ZOOM_MIN * 100)}
          aria-valuemax={Math.round(WATERFALL_ROW_ZOOM_MAX * 100)}
          aria-valuenow={Math.round(rowZoom * 100)}
          aria-valuetext={`${Math.round(rowZoom * 100)} percent${automaticRowZoom ? ', automatic' : ', saved'}`}
          title="Drag vertically to resize rows. Double-click or press 0 to restore automatic sizing."
          onDoubleClick={onRowZoomReset}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            rowDragRef.current = { y: event.clientY, zoom: rowZoom, pointerId: event.pointerId }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = rowDragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            const next = clampWaterfallRowZoom(drag.zoom + (drag.y - event.clientY) / 120)
            drag.zoom = next
            drag.y = event.clientY
            onRowZoomPreview(next)
          }}
          onPointerUp={(event) => {
            const drag = rowDragRef.current
            if (drag?.pointerId !== event.pointerId) return
            rowDragRef.current = null
            onRowZoomCommit(drag.zoom)
          }}
          onPointerCancel={() => {
            rowDragRef.current = null
            onRowZoomPreview(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
              event.preventDefault()
              setSteppedRowZoom(1)
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
              event.preventDefault()
              setSteppedRowZoom(-1)
            } else if (event.key === 'Home') {
              event.preventDefault()
              onRowZoomCommit(WATERFALL_ROW_ZOOM_MIN)
            } else if (event.key === 'End') {
              event.preventDefault()
              onRowZoomCommit(WATERFALL_ROW_ZOOM_MAX)
            } else if (event.key === '0') {
              event.preventDefault()
              onRowZoomReset()
            }
          }}
        >
          <MoveVertical size={11} aria-hidden="true" />
          <span>{Math.round(rowZoom * 100)}%</span>
        </span>
      </span>
      <div className="waterfall-axis-track">
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
        <div className="waterfall-axis-labels" aria-hidden="true">
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
        </div>
        {!following ? (
          <button
            data-pressable
            type="button"
            className="waterfall-live-resume"
            onClick={onFollow}
            aria-label={hasCurrentWork ? 'Follow current work and time' : 'Return to latest work'}
            title={
              hasCurrentWork
                ? 'Return to current work and keep the timeline moving with time'
                : 'Return to the latest completed work'
            }
          >
            <Crosshair size={9} aria-hidden="true" />
            {hasCurrentWork ? 'Follow now' : 'Latest work'}
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

/**
 * The bar's hover surface on Podium's own popover material — panel ink, seam
 * border, the transient-tier shadow — rather than the generic tooltip's
 * inverted slab, which reads as a foreign object inside this instrument.
 */
function WaterfallHoverPopup({ children }: { children: ReactNode }): JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side="top" sideOffset={6} className="isolate z-50">
        <TooltipPrimitive.Popup className="waterfall-hover-content">
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
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
      {/* Machine facts speak in the machine voice: mono, tabular digits. */}
      <div className="waterfall-hover-line waterfall-hover-mono">
        {formatWaterfallClock(startMs)} → {live ? 'now' : formatWaterfallClock(endMs)} ·{' '}
        {formatWaterfallDuration(endMs - startMs)} elapsed
      </div>
      {segments.length > 0 ? (
        <div className="waterfall-hover-line waterfall-hover-mono">
          {summary.workingStretches} work stretch{summary.workingStretches === 1 ? '' : 'es'} ·{' '}
          {formatWaterfallDuration(summary.workingMs)} working
          {summary.idleMs > 60_000 ? ` · ${formatWaterfallDuration(summary.idleMs)} waiting` : ''}
          {summary.attentionMs > 60_000
            ? ` · ${formatWaterfallDuration(summary.attentionMs)} on you`
            : ''}
        </div>
      ) : totalWorked && totalWorked > 0 ? (
        <div className="waterfall-hover-line waterfall-hover-mono">
          {formatWaterfallDuration(totalWorked)} worked in total
        </div>
      ) : null}
      {reason ? <div className="waterfall-hover-reason">{reason}</div> : null}
      {workers > 0 ? (
        <div className="waterfall-hover-line waterfall-hover-mono">
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
  const showDuration = barWidthPx >= 132 && placement === 'inside'

  const openMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenuAnchor({ x: event.clientX || rect.right, y: event.clientY || rect.bottom })
  }
  const openMenuFromKeyboard = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    setMenuAnchor({ x: rect.left + Math.min(rect.width, 24), y: rect.bottom })
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
          {side ? (
            <ChevronLeft size={10} aria-hidden="true" />
          ) : (
            <ChevronRight size={10} aria-hidden="true" />
          )}
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
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault()
                      openMenuFromKeyboard(event.currentTarget)
                      return
                    }
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
              {placement === 'inside' ? (
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
            <WaterfallHoverPopup>
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
            </WaterfallHoverPopup>
          </Tooltip>
          {placement === 'after' || placement === 'before' ? (
            <span
              className="waterfall-bar-tag"
              data-side={placement}
              data-state={state}
              aria-hidden="true"
            >
              {name}
              <span className="waterfall-bar-tag-time font-mono tabular-nums">
                {formatWaterfallDuration(endMs - startMs)}
              </span>
            </span>
          ) : null}
          {workers.length > 0 ? (
            <div className="waterfall-session-tools">
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
            </div>
          ) : null}
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
  onIssueMenu: (anchor: ContextMenuAnchor) => void
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
  const attention =
    future?.state === 'attention' ||
    item.sessions.some((session) => sessionAsksOnIssue(item.row.issue, session))
  return (
    <div
      className="waterfall-issue-row"
      data-flight-issue={item.row.issue.id}
      data-depth={item.row.depth}
      data-focused={focused || undefined}
      data-attention={attention || undefined}
      style={{ '--waterfall-depth': indent } as CSSProperties}
    >
      {/* The task and status are the visible controls. Advanced actions stay on
          the platform context gesture instead of occupying every row. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: context-click convenience; Shift+F10 is handled by the task button. */}
      <div
        className="waterfall-issue-cell"
        onContextMenu={(event) => {
          event.preventDefault()
          onIssueMenu({ x: event.clientX, y: event.clientY })
        }}
      >
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
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                onIssueMenu({ x: rect.left + Math.min(rect.width, 24), y: rect.bottom })
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              intent.commit(() => onSelectIssue(true))
            }}
          >
            <span className="waterfall-issue-title">{issueTitle}</span>
            <span className="waterfall-issue-meta font-mono">{issueMeta}</span>
          </button>
        )}
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
            {future.state === 'attention' ? (
              <span className="waterfall-attention-mark" aria-hidden="true" />
            ) : (
              <strong>{future.label}</strong>
            )}
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
  const [savedRowZoom, setSavedRowZoom] = usePersistedUiState<number | null>(
    FLIGHT_DECK_WATERFALL_ROW_ZOOM_KEY,
    readWaterfallRowZoom,
    writeWaterfallRowZoom,
  )
  const [rowZoomPreview, setRowZoomPreview] = useState<number | null>(null)
  const [availableHeight, setAvailableHeight] = useState(0)
  const initialLaneCounts = useMemo(
    () =>
      projected.map((item) => {
        const collapsedFinished = item.sessions.filter(
          (session) =>
            waterfallSessionState(session) === 'finished' &&
            !isCoordinatorSession(item.row.issue, session.sessionId) &&
            session.sessionId !== activeSessionId,
        ).length
        return collapsedFinished > 3
          ? Math.max(1, item.sessions.length - collapsedFinished + 1)
          : Math.max(1, item.sessions.length)
      }),
    [activeSessionId, projected],
  )
  const automaticRowZoom = useMemo(
    () => defaultWaterfallRowZoom(availableHeight, initialLaneCounts),
    [availableHeight, initialLaneCounts],
  )
  const rowZoom = rowZoomPreview ?? savedRowZoom ?? automaticRowZoom
  const commitRowZoom = useCallback(
    (next: number): void => {
      setRowZoomPreview(null)
      setSavedRowZoom(clampWaterfallRowZoom(next))
    },
    [setSavedRowZoom],
  )
  const resetRowZoom = useCallback((): void => {
    setRowZoomPreview(null)
    setSavedRowZoom(null)
  }, [setSavedRowZoom])

  const [savedTaskWidth, setSavedTaskWidth] = usePersistedUiState<number | null>(
    FLIGHT_DECK_WATERFALL_TASK_WIDTH_KEY,
    readWaterfallTaskWidth,
    writeWaterfallTaskWidth,
  )
  const [taskWidthPreview, setTaskWidthPreview] = useState<number | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [trackPx, setTrackPx] = useState(240)
  const [rootPx, setRootPx] = useState(0)
  const automaticTaskWidth = useMemo(
    () =>
      defaultWaterfallTaskWidth(
        projected.map((item) => item.displayTitle),
        rootPx,
        display === 'expanded',
      ),
    [display, projected, rootPx],
  )
  const taskWidth = clampWaterfallTaskWidth(
    taskWidthPreview ?? savedTaskWidth ?? automaticTaskWidth,
    rootPx,
  )
  const autoViewport = useMemo(
    () => followWaterfallViewport(sessions, now, trackPx, { future: hasFuture }),
    [hasFuture, now, sessions, trackPx],
  )
  const viewport = manual ?? autoViewport
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const probe = root.querySelector('.waterfall-axis-track')
    if (!(probe instanceof HTMLElement)) return
    trackRef.current = probe as HTMLDivElement
    const observer = new ResizeObserver(() => {
      setTrackPx(Math.max(60, probe.clientWidth))
      setRootPx(root.clientWidth)
    })
    observer.observe(probe)
    observer.observe(root)
    setTrackPx(Math.max(60, probe.clientWidth))
    setRootPx(root.clientWidth)
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
      setAvailableHeight(Math.max(0, scroller.clientHeight - chrome.offsetHeight))
    }
    const observer = new ResizeObserver(apply)
    observer.observe(chrome)
    observer.observe(scroller)
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

  // GESTURE COMMITS ARE FRAME-PACED. Wheel and pointermove fire far faster
  // than the display refreshes; a setState per event re-renders every lane per
  // mouse step. Streamed gestures coalesce into one commit per animation
  // frame, and while a gesture streams the root carries `data-interacting` so
  // the bars' settle transitions don't fight the live geometry.
  const pendingViewportRef = useRef<WaterfallViewport | null>(null)
  const gestureRafRef = useRef<number | null>(null)
  const interactingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveViewport = useCallback(
    (): WaterfallViewport => pendingViewportRef.current ?? frameRef.current.viewport,
    [],
  )
  const commitGestureViewport = useCallback((next: WaterfallViewport): void => {
    pendingViewportRef.current = next
    const root = rootRef.current
    if (root) {
      root.setAttribute('data-interacting', 'true')
      if (interactingTimerRef.current) clearTimeout(interactingTimerRef.current)
      interactingTimerRef.current = setTimeout(() => {
        root.removeAttribute('data-interacting')
      }, 180)
    }
    if (gestureRafRef.current !== null) return
    gestureRafRef.current = requestAnimationFrame(() => {
      gestureRafRef.current = null
      const pending = pendingViewportRef.current
      pendingViewportRef.current = null
      if (pending) setManual(pending)
    })
  }, [])
  useEffect(
    () => () => {
      if (gestureRafRef.current !== null) cancelAnimationFrame(gestureRafRef.current)
      if (interactingTimerRef.current) clearTimeout(interactingTimerRef.current)
    },
    [],
  )

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
        commitGestureViewport(zoomWaterfallViewport(liveViewport(), factor, fraction, current.now))
        return
      }
      const horizontal = event.shiftKey
        ? event.deltaY || event.deltaX
        : Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : 0
      if (horizontal !== 0) {
        event.preventDefault()
        commitGestureViewport(
          panWaterfallViewport(liveViewport(), horizontal * current.msPerPx, current.now),
        )
      }
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [commitGestureViewport, liveViewport])

  // Drag-to-pan on empty track space; clicks on bars and buttons stay clicks.
  const dragRef = useRef<{ x: number; viewport: WaterfallViewport; moved: boolean } | null>(null)
  const onTrackPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (!target.closest('.waterfall-track-cell')) return
    if (target.closest('button, input, a, [data-pressable]')) return
    dragRef.current = { x: event.clientX, viewport: frameRef.current.viewport, moved: false }
  }, [])
  const onTrackPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.x
      if (!drag.moved && Math.abs(dx) < 4) return
      drag.moved = true
      event.currentTarget.setPointerCapture(event.pointerId)
      commitGestureViewport(
        panWaterfallViewport(drag.viewport, -dx * frameRef.current.msPerPx, frameRef.current.now),
      )
    },
    [commitGestureViewport],
  )
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
    const anchor =
      current.nowPct >= 0 && current.nowPct <= 100
        ? Math.min(1, Math.max(0, current.nowPct / 100))
        : 0.5
    setManual(zoomWaterfallViewport(current.viewport, factor, anchor, current.now))
  }, [])
  const fitAll = useCallback((): void => {
    setManual(
      fitWaterfallViewport(timelineStart, frameRef.current.now, {
        future: hasFuture,
      }),
    )
  }, [hasFuture, timelineStart])

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
        fitAll()
      } else if (event.key === 'ArrowLeft' && event.altKey) {
        event.preventDefault()
        setManual(panWaterfallViewport(current.viewport, -span * 0.2, current.now))
      } else if (event.key === 'ArrowRight' && event.altKey) {
        event.preventDefault()
        setManual(panWaterfallViewport(current.viewport, span * 0.2, current.now))
      }
    },
    [fitAll, zoomBy],
  )

  const taskWidthDragRef = useRef<{
    x: number
    width: number
    latest: number
    pointerId: number
  } | null>(null)
  const onTaskWidthPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      taskWidthDragRef.current = {
        x: event.clientX,
        width: taskWidth,
        latest: taskWidth,
        pointerId: event.pointerId,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [taskWidth],
  )
  const onTaskWidthPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>): void => {
      const drag = taskWidthDragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      drag.latest = clampWaterfallTaskWidth(drag.width + event.clientX - drag.x, rootPx)
      setTaskWidthPreview(drag.latest)
    },
    [rootPx],
  )
  const finishTaskWidthDrag = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>, commit: boolean): void => {
      const drag = taskWidthDragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      taskWidthDragRef.current = null
      setTaskWidthPreview(null)
      if (commit) setSavedTaskWidth(drag.latest)
    },
    [setSavedTaskWidth],
  )
  const onTaskWidthKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key === 'Escape' || event.key === '0') {
        event.preventDefault()
        setTaskWidthPreview(null)
        setSavedTaskWidth(null)
        return
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next =
        event.key === 'Home'
          ? WATERFALL_TASK_WIDTH_MIN
          : event.key === 'End'
            ? WATERFALL_TASK_WIDTH_MAX
            : taskWidth +
              (event.key === 'ArrowLeft' ? -WATERFALL_TASK_WIDTH_STEP : WATERFALL_TASK_WIDTH_STEP)
      setSavedTaskWidth(clampWaterfallTaskWidth(next, rootPx))
    },
    [rootPx, setSavedTaskWidth, taskWidth],
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
  // Ticks live at the root so the axis labels and the gridlines running down
  // the rows come from the same array — a ruler whose lines drift from its
  // labels is worse than no lines at all.
  const ticks = useMemo(() => {
    // Half a label of clearance at either edge; centred labels clip otherwise.
    const edgePct = 1_500 / Math.max(1, frame.trackPx)
    const all = waterfallTicks(frame.viewport, frame.trackPx).filter(
      (tick) => tick.pct > edgePct && tick.pct < 100 - edgePct,
    )
    if (!nowInFrame) return all
    // The NOW chip outranks any wall-clock label it would sit on.
    return all.filter((tick) => (Math.abs(tick.pct - frame.nowPct) / 100) * frame.trackPx > 26)
  }, [frame.nowPct, frame.trackPx, frame.viewport, nowInFrame])
  const rowMetrics = waterfallRowMetrics(rowZoom)
  const hasCurrentWork = sessions.some((session) => !sessionSettled(session))
  const taskWidthMax = clampWaterfallTaskWidth(WATERFALL_TASK_WIDTH_MAX, rootPx)
  return (
    <TooltipProvider delay={140}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: zoom/pan gesture surface; every action here also has a real button or key. */}
      <div
        ref={rootRef}
        className={cn('flight-waterfall', display === 'expanded' && 'flight-waterfall-expanded')}
        data-testid="flight-deck-waterfall"
        data-display={display}
        data-following={manual === null || undefined}
        style={
          {
            '--waterfall-now': `${frame.nowPct}%`,
            '--waterfall-label-col': `${taskWidth}px`,
            '--waterfall-row-zoom': rowZoom,
            '--waterfall-bar-height': `${rowMetrics.bar}px`,
            '--waterfall-lane-height': `${rowMetrics.lane}px`,
            '--waterfall-row-gap': `${rowMetrics.gap}px`,
            '--waterfall-row-padding': `${rowMetrics.padding}px`,
          } as CSSProperties
        }
        onKeyDown={onKeyDown}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerUp}
        onDoubleClick={onTrackDoubleClick}
      >
        <WaterfallAxis
          frame={frame}
          ticks={ticks}
          following={manual === null}
          hasCurrentWork={hasCurrentWork}
          rowZoom={rowZoom}
          automaticRowZoom={savedRowZoom === null}
          onZoom={zoomBy}
          onRowZoomPreview={setRowZoomPreview}
          onRowZoomCommit={commitRowZoom}
          onRowZoomReset={resetRowZoom}
          onFit={fitAll}
          onFollow={() => setManual(null)}
        />
        <span
          className="waterfall-column-resizer"
          role="separator"
          tabIndex={0}
          aria-label="Task details width"
          aria-orientation="vertical"
          aria-valuemin={WATERFALL_TASK_WIDTH_MIN}
          aria-valuemax={taskWidthMax}
          aria-valuenow={taskWidth}
          aria-valuetext={`${taskWidth} pixels${savedTaskWidth === null ? ', automatic' : ', saved'}`}
          data-dragging={taskWidthPreview !== null || undefined}
          title="Drag to resize task details. Double-click, press 0, or press Escape to restore automatic width."
          onDoubleClick={() => setSavedTaskWidth(null)}
          onPointerDown={onTaskWidthPointerDown}
          onPointerMove={onTaskWidthPointerMove}
          onPointerUp={(event) => finishTaskWidthDrag(event, true)}
          onPointerCancel={(event) => finishTaskWidthDrag(event, false)}
          onLostPointerCapture={(event) => finishTaskWidthDrag(event, false)}
          onKeyDown={onTaskWidthKeyDown}
        />
        <div className="waterfall-gridlines" aria-hidden="true">
          <div className="waterfall-gridlines-track">
            {ticks.map((tick) => (
              <span key={tick.at} style={{ left: `${tick.pct}%` }} />
            ))}
          </div>
        </div>
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
              onIssueMenu={(anchor) => onIssueMenu(item.row.issue.id, anchor)}
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
