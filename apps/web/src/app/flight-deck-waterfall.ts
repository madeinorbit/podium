import { motionPhase, sessionNeedsHuman, sessionSettled } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model/browser'

/**
 * WATERFALL GEOMETRY v2 (POD-1854).
 *
 * The first waterfall mapped a fixed 48-hour window onto a fixed 72% of the
 * track, which meant every bar started at roughly the same pixel and the view
 * carried no temporal information at all. This engine is viewport-based, the
 * way every serious trace viewer works: a `WaterfallViewport` names the visible
 * [start, end] time range, geometry is a pure projection through it, and the
 * component chooses between an auto-fit viewport that follows Now and a manual
 * one produced by zoom/pan gestures.
 *
 * Segments are the second correction: a session that worked, waited on review
 * and worked again used to render as one solid stretch. Phase samples from
 * `sessions.activityHistory` fold into working / attention / idle segments so
 * the bar tells the truth about where the time went. No samples is a legal
 * state (pre-feature sessions, pruned history) and degrades to today's solid
 * bar — absence of evidence stays visually distinct from evidence of idling.
 */

export const WATERFALL_MAX_WINDOW_MS = 48 * 60 * 60 * 1_000
export const WATERFALL_MIN_WINDOW_MS = 5 * 60 * 1_000
/** Hard zoom-in floor: below two minutes the phase data has nothing to say. */
export const WATERFALL_MIN_SPAN_MS = 2 * 60 * 1_000
/** Fraction of the fitted span left as breathing room ahead of Now. */
const FUTURE_HEADROOM = 0.16
const FUTURE_HEADROOM_BARE = 0.05
/** Lead-in pad behind the earliest bar so it does not touch the label column. */
const FIT_LEAD = 0.02
/** Default bar width that leaves room for an agent name and its leading glyph. */
const FOLLOW_BAR_TARGET_PX = 112

export type WaterfallSessionState = 'finished' | 'live' | 'working' | 'attention'

export interface WaterfallViewport {
  start: number
  end: number
}

export interface WaterfallBarGeometry {
  /** Percent offsets within the track; clamped to [0, 100]. */
  leftPct: number
  widthPct: number
  clippedStart: boolean
  clippedEnd: boolean
  visible: boolean
}

export type WaterfallSegmentKind = 'working' | 'attention' | 'idle'

export interface WaterfallSegment {
  start: number
  end: number
  kind: WaterfallSegmentKind
}

export interface WaterfallActivitySample {
  at: number
  phase: string
}

export interface WaterfallTick {
  at: number
  pct: number
  label: string
}

function time(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function waterfallSessionState(session: SessionMeta): WaterfallSessionState {
  if (sessionSettled(session)) return 'finished'
  if (sessionNeedsHuman(session)) return 'attention'
  return motionPhase(session) === 'working' ? 'working' : 'live'
}

export function waterfallSessionStart(session: SessionMeta, fallback: number): number {
  return time(session.createdAt) ?? time(session.lastActiveAt) ?? fallback
}

export function waterfallSessionEnd(session: SessionMeta, now: number): number {
  if (!sessionSettled(session)) return now
  return time(session.stoppedAt) ?? time(session.lastActiveAt) ?? time(session.createdAt) ?? now
}

/** Earliest known start across the crew — null when nothing has a timestamp. */
export function waterfallTimelineStart(sessions: readonly SessionMeta[]): number | null {
  let earliest: number | null = null
  for (const session of sessions) {
    const candidate = time(session.createdAt) ?? time(session.lastActiveAt)
    if (candidate !== null) earliest = earliest === null ? candidate : Math.min(earliest, candidate)
  }
  return earliest
}

/**
 * The auto-fit viewport: every visible bar on screen, Now inside the frame
 * with headroom ahead of it for future labels and growth. Recomputed on every
 * clock tick, which IS the live-follow behaviour — the frame slides with Now
 * until the operator zooms or pans, at which point the component freezes a
 * manual viewport and this function stops being consulted.
 */
export function fitWaterfallViewport(
  timelineStart: number | null,
  now: number,
  options: { future?: boolean } = {},
): WaterfallViewport {
  const earliest = Math.min(timelineStart ?? now, now)
  const span = Math.min(WATERFALL_MAX_WINDOW_MS, Math.max(WATERFALL_MIN_WINDOW_MS, now - earliest))
  const headroom = options.future ? FUTURE_HEADROOM : FUTURE_HEADROOM_BARE
  return {
    start: now - span * (1 + FIT_LEAD),
    end: now + span * headroom,
  }
}

/**
 * The useful default is a detail view, not an archive fit. Live sessions end
 * at Now, so their right edges share a stable anchor while older completed
 * work is allowed to leave the frame. Once the crew has stopped, the same
 * calculation parks on the latest completed work instead of showing an empty
 * gap between that work and today's clock.
 */
export function followWaterfallViewport(
  sessions: readonly SessionMeta[],
  now: number,
  trackPx: number,
  options: { future?: boolean } = {},
): WaterfallViewport {
  if (sessions.length === 0) return fitWaterfallViewport(null, now, options)

  const active = sessions.filter((session) => !sessionSettled(session))
  const byMostRecent = [...sessions].sort(
    (left, right) =>
      waterfallSessionEnd(right, now) - waterfallSessionEnd(left, now) ||
      waterfallSessionStart(right, now) - waterfallSessionStart(left, now),
  )
  const focus = active.length > 0 ? active : byMostRecent.slice(0, 3)
  const focusEnd = active.length > 0 ? now : waterfallSessionEnd(focus[0] ?? sessions[0], now)
  const durations = focus
    .map((session) =>
      Math.max(
        WATERFALL_MIN_SPAN_MS,
        waterfallSessionEnd(session, now) - waterfallSessionStart(session, now),
      ),
    )
    .sort((left, right) => left - right)
  const typicalDuration =
    durations[Math.floor((durations.length - 1) / 2)] ?? WATERFALL_MIN_WINDOW_MS
  const detailSpan = typicalDuration * Math.max(2, Math.max(1, trackPx) / FOLLOW_BAR_TARGET_PX)
  const newestStart = Math.max(...focus.map((session) => waterfallSessionStart(session, focusEnd)))
  const contentSpan = Math.min(
    WATERFALL_MAX_WINDOW_MS,
    Math.max(WATERFALL_MIN_WINDOW_MS, focusEnd - newestStart, detailSpan),
  )
  const headroom = options.future ? FUTURE_HEADROOM : FUTURE_HEADROOM_BARE
  return {
    start: focusEnd - contentSpan * (1 + FIT_LEAD),
    end: focusEnd + contentSpan * headroom,
  }
}

function clampViewport(viewport: WaterfallViewport, now: number): WaterfallViewport {
  const span = Math.max(WATERFALL_MIN_SPAN_MS, viewport.end - viewport.start)
  let start = viewport.start
  let end = start + span
  const minStart = now - WATERFALL_MAX_WINDOW_MS * 1.05
  const maxEnd = now + span * 0.6
  if (end > maxEnd) {
    end = maxEnd
    start = end - span
  }
  if (start < minStart) {
    start = minStart
    end = start + span
  }
  return { start, end }
}

/**
 * Zoom around an anchor given as a fraction of the current frame — the trace
 * viewer contract: the time under the cursor stays under the cursor.
 */
export function zoomWaterfallViewport(
  viewport: WaterfallViewport,
  factor: number,
  anchorFraction: number,
  now: number,
): WaterfallViewport {
  const span = viewport.end - viewport.start
  const nextSpan = Math.min(
    WATERFALL_MAX_WINDOW_MS * 1.3,
    Math.max(WATERFALL_MIN_SPAN_MS, span * factor),
  )
  const anchor = viewport.start + span * anchorFraction
  const start = anchor - nextSpan * anchorFraction
  return clampViewport({ start, end: start + nextSpan }, now)
}

export function panWaterfallViewport(
  viewport: WaterfallViewport,
  deltaMs: number,
  now: number,
): WaterfallViewport {
  return clampViewport({ start: viewport.start + deltaMs, end: viewport.end + deltaMs }, now)
}

export function waterfallPercent(viewport: WaterfallViewport, at: number): number {
  return ((at - viewport.start) / (viewport.end - viewport.start)) * 100
}

export function waterfallBarGeometry(
  startMs: number,
  endMs: number,
  viewport: WaterfallViewport,
): WaterfallBarGeometry {
  const left = waterfallPercent(viewport, startMs)
  const right = waterfallPercent(viewport, Math.max(startMs, endMs))
  const leftPct = Math.max(0, Math.min(100, left))
  const rightPct = Math.max(0, Math.min(100, right))
  return {
    leftPct,
    widthPct: Math.max(0, rightPct - leftPct),
    clippedStart: left < 0,
    clippedEnd: right > 100,
    visible: right > 0 && left < 100,
  }
}

/** Wall-clock-aligned "nice" steps, smallest first. */
const TICK_STEPS_MS = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
]

function clockLabel(at: number, spanMs: number): string {
  const date = new Date(at)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (spanMs <= 20 * 60 * 60_000) return clock
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.getHours() === 0 && date.getMinutes() === 0 ? weekday : `${weekday} ${clock}`
}

/**
 * Adaptive ruler: the densest wall-clock-aligned step whose ticks keep at
 * least `minTickPx` between them, so labels never collide at any zoom.
 */
export function waterfallTicks(
  viewport: WaterfallViewport,
  trackPx: number,
  minTickPx = 64,
): WaterfallTick[] {
  const span = viewport.end - viewport.start
  if (span <= 0 || trackPx <= 0) return []
  const step =
    TICK_STEPS_MS.find((candidate) => (candidate / span) * trackPx >= minTickPx) ??
    TICK_STEPS_MS[TICK_STEPS_MS.length - 1] ??
    60_000
  const offset = new Date(viewport.start).getTimezoneOffset() * 60_000
  const first = Math.ceil((viewport.start - offset) / step) * step + offset
  const ticks: WaterfallTick[] = []
  for (let at = first; at <= viewport.end; at += step) {
    const pct = waterfallPercent(viewport, at)
    if (pct < 0.5 || pct > 99.5) continue
    ticks.push({ at, pct, label: clockLabel(at, span) })
  }
  return ticks
}

function segmentKind(phase: string): WaterfallSegmentKind | 'off' {
  switch (phase) {
    case 'working':
    case 'compacting':
      return 'working'
    case 'needs_user':
    case 'errored':
      return 'attention'
    case 'ended':
      return 'off'
    default:
      return 'idle'
  }
}

/**
 * Fold phase samples into contiguous bar segments over [startMs, endMs].
 * Samples before the interval carry their phase in; the final sample extends
 * to the interval end (Now for a live session). An empty sample list returns
 * [] — the caller renders the undifferentiated solid bar instead of guessing.
 */
export function waterfallSegments(
  samples: readonly WaterfallActivitySample[],
  startMs: number,
  endMs: number,
): WaterfallSegment[] {
  if (samples.length === 0 || endMs <= startMs) return []
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  const segments: WaterfallSegment[] = []
  let cursor = startMs
  let kind: WaterfallSegmentKind | 'off' = 'idle'
  const push = (until: number): void => {
    const clampedFrom = Math.max(startMs, Math.min(endMs, cursor))
    const clampedTo = Math.max(startMs, Math.min(endMs, until))
    if (clampedTo > clampedFrom && kind !== 'off') {
      const last = segments[segments.length - 1]
      if (last && last.kind === kind && last.end === clampedFrom) last.end = clampedTo
      else segments.push({ start: clampedFrom, end: clampedTo, kind })
    }
    cursor = until
  }
  for (const sample of sorted) {
    if (sample.at > cursor) push(sample.at)
    else cursor = Math.max(cursor, Math.min(sample.at, endMs))
    kind = segmentKind(sample.phase)
    cursor = Math.max(startMs, Math.min(endMs, sample.at))
  }
  push(endMs)
  return segments
}

/**
 * Collapse segments too small to draw at the current scale into their
 * neighbours (Perfetto's sub-pixel merge). Working beats idle when merging so
 * a real burst never disappears into a wait.
 */
export function foldWaterfallSegments(
  segments: readonly WaterfallSegment[],
  msPerPx: number,
  minPx = 2,
): WaterfallSegment[] {
  if (segments.length <= 1) return [...segments]
  const minMs = msPerPx * minPx
  const rank: Record<WaterfallSegmentKind, number> = { attention: 3, working: 2, idle: 1 }
  const folded: WaterfallSegment[] = []
  for (const segment of segments) {
    const previous = folded[folded.length - 1]
    if (!previous) {
      folded.push({ ...segment })
      continue
    }
    const tiny = segment.end - segment.start < minMs
    const previousTiny = previous.end - previous.start < minMs
    if (previous.kind === segment.kind || (tiny && !previousTiny)) {
      previous.end = segment.end
      continue
    }
    if (previousTiny) {
      const stronger = rank[segment.kind] >= rank[previous.kind] ? segment.kind : previous.kind
      previous.kind = stronger
      previous.end = segment.end
      continue
    }
    folded.push({ ...segment })
  }
  // A second pass merges runs the folding may have made adjacent.
  const merged: WaterfallSegment[] = []
  for (const segment of folded) {
    const previous = merged[merged.length - 1]
    if (previous && previous.kind === segment.kind) previous.end = segment.end
    else merged.push({ ...segment })
  }
  return merged
}

export interface WaterfallActivitySummary {
  workingMs: number
  attentionMs: number
  idleMs: number
  workingStretches: number
}

export function summarizeWaterfallSegments(
  segments: readonly WaterfallSegment[],
): WaterfallActivitySummary {
  const summary: WaterfallActivitySummary = {
    workingMs: 0,
    attentionMs: 0,
    idleMs: 0,
    workingStretches: 0,
  }
  for (const segment of segments) {
    const span = segment.end - segment.start
    if (segment.kind === 'working') {
      summary.workingMs += span
      summary.workingStretches += 1
    } else if (segment.kind === 'attention') summary.attentionMs += span
    else summary.idleMs += span
  }
  return summary
}

/** Bar-label ladder: inside while it fits, floated after the bar while there
 *  is room, floated before as the fallback, tooltip-only past that. */
export type WaterfallLabelPlacement = 'inside' | 'after' | 'before' | 'none'

export function waterfallLabelPlacement(
  barLeftPx: number,
  barWidthPx: number,
  trackPx: number,
  labelPx = 88,
): WaterfallLabelPlacement {
  if (barWidthPx >= labelPx) return 'inside'
  if (trackPx - (barLeftPx + barWidthPx) >= labelPx + 8) return 'after'
  if (barLeftPx >= labelPx + 8) return 'before'
  return 'none'
}

export function formatWaterfallDuration(milliseconds: number): string {
  if (milliseconds < 59_500) return `${Math.max(1, Math.round(milliseconds / 1_000))}s`
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}

export function formatWaterfallClock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
