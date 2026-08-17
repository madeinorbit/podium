/**
 * The timer/ago stamp of the motion grammar — the anchor of every phase morph
 * (.design/specs/motion.md §2.3):
 *
 *   working — working mark + green mono `m:ss` counting up (the only other
 *             permanent motion besides the mark itself); enters with a
 *             one-shot tick-in when the phase changes under an already-mounted
 *             row.
 *   waiting — the counter freezes and flips into an amber "just now"/"Nm ago"
 *             stamp (one-shot flip, then perfectly still — the text updates at
 *             minute granularity but nothing animates).
 *   done    — grey cumulative compute total; renders nothing until a total is
 *             supplied (backend `workingMsTotal` is a separate issue).
 *
 * The component is stateless about accumulation: `sinceMs` is the last phase
 * change (`agentState.since`) and `baseMs` is compute time accumulated before
 * the current working stretch, so a waiting→working resume continues the count
 * instead of resetting (the caller decides when a run truly restarts).
 */

import { relativeTime } from '@podium/client-core/focus'
import { formatClock, type MotionPhase } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { usePhaseMorph } from './usePhaseMorph'
import { WorkingMark } from './WorkingMark'

const HOUR_MS = 3_600_000

export function PhaseTimer({
  phase,
  sinceMs,
  baseMs = 0,
  totalMs,
  size = 9,
  showSpinner = true,
  plainLanguage = false,
  leadingSeparator = false,
  mutedWaiting = false,
  mutedWorking = false,
  className,
}: {
  phase: MotionPhase
  /** Epoch ms of the last phase change (`agentState.since`). */
  sinceMs: number
  /** Compute ms accumulated before the current working stretch (resume, not reset). */
  baseMs?: number
  /** Cumulative compute ms for the done `∑` stamp; omitted → renders nothing when done. */
  totalMs?: number
  /** Font size in px: 9 sidebar rows/tabs, 10 mobile menu. */
  size?: number
  /** False when a surrounding lifecycle lockup already owns the working icon. */
  showSpinner?: boolean
  /** Prefer short human copy (`5:40 total`) over symbolic telemetry (`∑ 5:40`). */
  plainLanguage?: boolean
  /** Prefix the time with a quiet middle dot when it follows a status phrase. */
  leadingSeparator?: boolean
  /** Render the waiting "ago" stamp in dim ink instead of amber (POD-293): in
   *  the work sidebar the ask itself is the one amber signal, so the timestamp
   *  beside it must not double it. The flip-in morph still passes through amber. */
  mutedWaiting?: boolean
  /** Render the working clock's DIGITS on the neutral ramp, leaving the braille
   *  spinner as the only blue in the lockup (POD-1253). The 3a artboard writes
   *  the sidebar's meta column exactly this way — `<span blue>⠋</span> 4:53` on
   *  the same ink as every other stamp in the column — because a whole clock in
   *  live blue beside a status line that is already saying "working" spends the
   *  signal twice on one fact. Everywhere else (the Flight Deck, the issue page)
   *  the clock IS the fact and keeps the blue. */
  mutedWorking?: boolean
  className?: string
}): JSX.Element | null {
  const morph = usePhaseMorph(phase)
  // One interval per timer so the second-hand never re-renders a whole list;
  // seconds only matter while working and under an hour on the clock.
  const coarse = phase !== 'working' || Date.now() - sinceMs + baseMs >= HOUR_MS
  const now = useNow(coarse ? 60_000 : 1_000)

  if (phase === 'working') {
    return (
      <span
        key="working"
        className={cn(
          'inline-flex items-center gap-[5px] font-mono tabular-nums',
          morph === 'working' && 'morph-tick-in',
          className,
        )}
        style={{
          fontSize: size,
          color: mutedWorking ? 'var(--muted-foreground)' : 'var(--motion-working)',
        }}
        title={`Working since ${new Date(sinceMs).toLocaleString()}`}
      >
        {/* The mark's cell is taller than the digits beside it — the design
            pairs a 12px cell with 9px mono — so it scales off the type size
            rather than matching it.

            AND IT KEEPS THE BLUE THROUGH A MUTED LOCKUP: `.pod-mark` fills with
            `var(--mark-color, var(--motion-working))` rather than inheriting
            `color`, so `mutedWorking` takes the digits to the neutral ramp and
            leaves the mark alone — which is the artboard's meta column exactly,
            a live mark in front of a stamp that reads like every other stamp. */}
        {showSpinner && <WorkingMark size={Math.round(size * 1.33)} />}
        {leadingSeparator && <span aria-hidden="true">·</span>}
        {formatClock(baseMs + (now - sinceMs))}
      </span>
    )
  }
  if (phase === 'waiting') {
    return (
      <span
        key="waiting"
        className={cn('font-mono tabular-nums', morph === 'waiting' && 'morph-flip-ago', className)}
        style={{
          fontSize: size,
          color: mutedWaiting ? 'var(--text-dim)' : 'var(--motion-waiting)',
        }}
        title={`Waiting since ${new Date(sinceMs).toLocaleString()}`}
      >
        {leadingSeparator && <span aria-hidden="true">· </span>}
        {relativeTime(new Date(sinceMs).toISOString(), now)}
      </span>
    )
  }
  if (phase === 'done' && totalMs !== undefined) {
    return (
      <span
        key="done"
        className={cn('font-mono tabular-nums', className)}
        style={{ fontSize: size, color: 'var(--motion-total)' }}
        title="Total compute time"
      >
        {leadingSeparator && <span aria-hidden="true">· </span>}
        {plainLanguage ? `${formatClock(totalMs)} total` : `∑ ${formatClock(totalMs)}`}
      </span>
    )
  }
  // queued (and done without a total): still, no meta — the row itself carries
  // the dimmed queued look.
  return null
}
