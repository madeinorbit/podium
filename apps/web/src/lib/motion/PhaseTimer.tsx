/**
 * The timer/ago stamp of the motion grammar — the anchor of every phase morph
 * (.design/specs/motion.md §2.3):
 *
 *   working — braille spinner + green mono `m:ss` counting up (the only other
 *             permanent motion besides the spinner itself); enters with a
 *             one-shot tick-in when the phase changes under an already-mounted
 *             row.
 *   waiting — the counter freezes and flips into an amber "just now"/"Nm ago"
 *             stamp (one-shot flip, then perfectly still — the text updates at
 *             minute granularity but nothing animates).
 *   done    — grey `∑ m:ss` cumulative compute total; renders nothing until a
 *             total is supplied (backend `workingMsTotal` is a separate issue).
 *
 * The component is stateless about accumulation: `sinceMs` is the last phase
 * change (`agentState.since`) and `baseMs` is compute time accumulated before
 * the current working stretch, so a waiting→working resume continues the count
 * instead of resetting (the caller decides when a run truly restarts).
 */
import type { JSX } from 'react'
import { formatClock, type MotionPhase } from '@/lib/derive'
import { relativeTime } from '@/lib/home'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { BrailleSpinner } from './BrailleSpinner'
import { usePhaseMorph } from './usePhaseMorph'

const HOUR_MS = 3_600_000

export function PhaseTimer({
  phase,
  sinceMs,
  baseMs = 0,
  totalMs,
  size = 9,
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
        style={{ fontSize: size, color: 'var(--motion-working)' }}
        title={`Working since ${new Date(sinceMs).toLocaleString()}`}
      >
        <BrailleSpinner size={size} />
        {formatClock(baseMs + (now - sinceMs))}
      </span>
    )
  }
  if (phase === 'waiting') {
    return (
      <span
        key="waiting"
        className={cn('font-mono tabular-nums', morph === 'waiting' && 'morph-flip-ago', className)}
        style={{ fontSize: size, color: 'var(--motion-waiting)' }}
        title={`Waiting since ${new Date(sinceMs).toLocaleString()}`}
      >
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
        {`∑ ${formatClock(totalMs)}`}
      </span>
    )
  }
  // queued (and done without a total): still, no meta — the row itself carries
  // the dimmed queued look.
  return null
}
