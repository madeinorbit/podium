/**
 * Sidebar time indicators: the live elapsed timer on WORKING rows ("how long
 * has this been running") and the compact relative stamp on WORK rows
 * ("when did this last move"). Pure format/derive helpers are exported
 * separately so they unit-test without a clock.
 */
import type { SessionMeta } from '@podium/protocol'
import type { JSX } from 'react'
import { isSessionWorking } from '@/lib/derive'
import { relativeTime } from '@/lib/home'
import { useNow } from '@/lib/useNow'

const HOUR_MS = 3_600_000

/** Compact elapsed duration: `34s` / `12m 34s` / `2h 5m` / `1d 3h`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * When a row's work started: the EARLIEST working-phase change among its
 * currently-working sessions (`agentState.since` — the harness stamps it on
 * every phase transition), so the timer reads "working for N". Sessions with
 * no agentState (busy shells) fall back to lastActiveAt. Null when nothing
 * in the set is working.
 */
export function workingSinceMs(sessions: SessionMeta[]): number | null {
  let earliest: number | null = null
  for (const s of sessions) {
    if (!isSessionWorking(s)) continue
    const t = Date.parse(s.agentState?.since ?? s.lastActiveAt)
    if (!Number.isFinite(t)) continue
    if (earliest === null || t < earliest) earliest = t
  }
  return earliest
}

const STAMP_CLASS = 'flex-none text-[10px] tabular-nums text-[#6c6c78]'

/** Live elapsed timer for a WORKING row. Ticks every second while the display
 *  shows seconds (<1h), then drops to a once-a-minute tick — each timer owns
 *  its own interval so the second-hand never re-renders the whole sidebar. */
export function WorkingTimer({ sinceMs }: { sinceMs: number }): JSX.Element {
  const coarse = Date.now() - sinceMs >= HOUR_MS
  const now = useNow(coarse ? 60_000 : 1_000)
  return (
    <span className={STAMP_CLASS} title={`Working since ${new Date(sinceMs).toLocaleString()}`}>
      {formatElapsed(now - sinceMs)}
    </span>
  )
}

/** Relative "2h ago" stamp for WORK rows. `now` rides the caller's coarse
 *  clock (the sidebar already ticks at minute granularity). */
export function AgoStamp({ atMs, now }: { atMs: number; now: number }): JSX.Element | null {
  if (!Number.isFinite(atMs) || atMs <= 0) return null
  return (
    <span className={STAMP_CLASS} title={new Date(atMs).toLocaleString()}>
      {relativeTime(new Date(atMs).toISOString(), now)}
    </span>
  )
}
