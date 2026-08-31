import { motionPhase, sessionNeedsHuman, sessionSettled } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model/browser'

export const WATERFALL_NOW_PERCENT = 78
export const WATERFALL_MIN_WINDOW_MS = 30 * 60 * 1_000
export const WATERFALL_MAX_WINDOW_MS = 48 * 60 * 60 * 1_000

export type WaterfallSessionState = 'finished' | 'live' | 'working' | 'attention'

export interface WaterfallTimeline {
  start: number
  now: number
  duration: number
  nowPercent: number
}

export interface WaterfallInterval {
  start: number
  end: number
  left: number
  width: number
  clippedStart: boolean
  state: WaterfallSessionState
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

/**
 * A bounded history window keeps the Now line fixed while a long-running epic
 * remains usable. Old spans clip at the left edge instead of compressing recent
 * work into a few pixels. The remaining 22 percent is reserved for dependency
 * and waiting labels, never fabricated durations.
 */
export function waterfallTimelineStart(sessions: readonly SessionMeta[]): number | null {
  let earliest: number | null = null
  for (const session of sessions) {
    const candidate = time(session.createdAt) ?? time(session.lastActiveAt)
    if (candidate !== null) earliest = earliest === null ? candidate : Math.min(earliest, candidate)
  }
  return earliest
}

export function buildWaterfallTimelineFromStart(
  timelineStart: number | null,
  now: number,
): WaterfallTimeline {
  const earliest = Math.min(timelineStart ?? now, now)
  const duration = Math.min(
    WATERFALL_MAX_WINDOW_MS,
    Math.max(WATERFALL_MIN_WINDOW_MS, now - earliest),
  )
  return {
    start: now - duration,
    now,
    duration,
    nowPercent: WATERFALL_NOW_PERCENT,
  }
}

export function buildWaterfallTimeline(
  sessions: readonly SessionMeta[],
  now: number,
): WaterfallTimeline {
  return buildWaterfallTimelineFromStart(waterfallTimelineStart(sessions), now)
}

export function waterfallInterval(
  session: SessionMeta,
  timeline: WaterfallTimeline,
): WaterfallInterval {
  const actualStart = waterfallSessionStart(session, timeline.now)
  const actualEnd = Math.max(actualStart, waterfallSessionEnd(session, timeline.now))
  const start = Math.max(timeline.start, Math.min(timeline.now, actualStart))
  const end = Math.max(start, Math.min(timeline.now, actualEnd))
  const scale = timeline.nowPercent / timeline.duration
  const left = (start - timeline.start) * scale
  const naturalWidth = (end - start) * scale
  return {
    start: actualStart,
    end: actualEnd,
    left: Math.max(0, Math.min(timeline.nowPercent, left)),
    width: Math.max(1.25, Math.min(timeline.nowPercent - left, naturalWidth)),
    clippedStart: actualStart < timeline.start,
    state: waterfallSessionState(session),
  }
}

export function waterfallAxisTicks(timeline: WaterfallTimeline): Array<{
  left: number
  label: string
}> {
  return [0, 0.25, 0.5, 0.75].map((fraction) => {
    const elapsed = timeline.duration * (1 - fraction)
    const hours = elapsed / (60 * 60 * 1_000)
    const label = hours >= 1 ? `-${Math.round(hours)}h` : `-${Math.max(1, Math.round(hours * 60))}m`
    return { left: fraction * timeline.nowPercent, label }
  })
}

export function formatWaterfallDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}
