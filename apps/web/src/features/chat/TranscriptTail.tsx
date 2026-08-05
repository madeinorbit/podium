import { type ChatActivity, formatClock } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { BrailleSpinner } from '@/lib/motion/BrailleSpinner'
import { useNow } from '@/lib/useNow'

/**
 * THE TAIL (POD-376) — the end of the feed, as ONE object in three states.
 *
 * It replaces two unrelated placeholders: a three-dot bounce that fired for
 * every tone (working, needs-you, sending) and a separate "Idle for 17m 39s"
 * clock that appeared when the first one didn't. Both said the same thing in
 * different shapes, and the bounce was perpetual motion in a system whose
 * grammar reserves that for one thing.
 *
 * ONE SHAPE, THREE WEIGHTS. A mark, a phrase, a mono figure, and a rule running
 * out to the right edge — so the transcript visibly ENDS somewhere instead of
 * trailing off. What changes between states is weight, not layout:
 *
 *   working   the braille spinner and a counting timer, in the live hue. The
 *             motion grammar's only perpetual motion, and this is the one place
 *             in the feed licensed to use it (DESIGN.md §5, Agent State).
 *   waiting   still, and the brightest of the three. Stillness is what "needs
 *             you" means here, so the row earns the attention keyline and does
 *             NOT recede — it is the one state the reader must act on. It
 *             arrives with a single one-shot morph and then holds.
 *   idle      recedes: dim, quoted in minutes, and dimmer again past ten of
 *             them. Nothing is happening and nothing is being asked, so the row
 *             should cost the eye as little as it costs the session.
 *
 * The figures coarsen with the state. Only a live timer earns per-second
 * precision; an idle clock counting "17m 39s → 17m 40s" is motion that says
 * nothing, redrawing 59 times to change one digit the reader was never reading.
 */

/** `chatActivity` speaks in session-state terms ("needs answer") because the
 *  sidebar and the tab strip label sessions, not readers. At the end of the feed
 *  the reader IS the one being addressed, so the phrase says so. */
const WAITING_LABEL: Record<string, string> = {
  'needs answer': 'Waiting for your answer',
  'needs permission': 'Waiting for your approval',
}

/** Seconds in the first minute, then whole minutes: past 60s the seconds digit
 *  is noise, and dropping it is what lets the row stop redrawing. */
function coarseElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Past this an idle session is background, not news — the row dims again. */
const STALE_IDLE_MS = 10 * 60_000

export function TranscriptTail({
  activity,
  since,
}: {
  /** The session's live activity, or null when nothing is running. */
  activity: ChatActivity | null
  /** When the agent last changed phase — the origin for every figure here. */
  since?: string | undefined
}): JSX.Element | null {
  const startedAt = since ? Date.parse(since) : Number.NaN
  const known = !Number.isNaN(startedAt)
  const working = activity?.tone === 'working'
  // Two clocks so nothing wakes faster than its figure can change: the working
  // timer counts seconds, and an idle one only needs that in its first minute.
  const coarse = useNow(working ? 1000 : 20_000)
  const fresh = known && coarse - startedAt < 60_000
  const fine = useNow(1000, !working && fresh)
  const now = working || !fresh ? coarse : fine
  const elapsed = known ? Math.max(0, now - startedAt) : 0

  if (!activity && !known) return null

  const kind = working
    ? 'working'
    : activity?.tone === 'attention'
      ? 'waiting'
      : activity
        ? 'note'
        : 'idle'
  const label = working
    ? activity.label
    : kind === 'waiting'
      ? (WAITING_LABEL[activity?.label ?? ''] ?? 'Waiting for you')
      : kind === 'note'
        ? (activity?.label ?? '')
        : 'Idle'
  // A live timer reads as a clock (0:42); everything else is a duration.
  const figure = !known ? null : working ? formatClock(elapsed) : coarseElapsed(elapsed)

  return (
    <div
      // Keyed on the state so a PHASE CHANGE remounts the row and replays its
      // one-shot arrival — the motion grammar's "morph, then be still". A
      // ticking figure inside one state must not re-trigger it, and does not.
      key={kind}
      className="feed-tail"
      data-tail={kind}
      data-stale={kind === 'idle' && elapsed >= STALE_IDLE_MS ? 'true' : undefined}
      data-testid="feed-tail"
      // A live region for the states that CHANGE — a phase transition is worth
      // announcing. Idle is not a change, and would announce on every tick.
      {...(kind === 'working' || kind === 'waiting'
        ? ({ role: 'status', 'aria-live': 'polite' } as const)
        : {})}
    >
      {/* Mark, phrase and figure travel together so the waiting state can put a
          keyline round the three of them without the rule joining in. */}
      <span className="feed-tail-body">
        <span className="feed-tail-mark" aria-hidden="true">
          {working ? <BrailleSpinner size={11} /> : <span className="feed-tail-dot" />}
        </span>
        <span className="feed-tail-label">{label}</span>
        {/* The working timer lives inside the live region, so it is hidden from
            it: a counter that announces once a second says nothing and blocks
            everything else. The still figures stay readable. */}
        {figure !== null && (
          <span className="feed-tail-figure" aria-hidden={working ? 'true' : undefined}>
            {figure}
          </span>
        )}
      </span>
      <span className="feed-tail-rule" aria-hidden="true" />
    </div>
  )
}
