/**
 * THE BREATH (POD-993) — the working mark at the END of the feed.
 *
 * The braille spinner stays the system's machine-voice spinner: it rides inside
 * work lines, sidebar rows and tabs, where a mono glyph sits in a mono line and
 * anything else would be a foreign object. The tail is a different problem. It
 * is the one place in the window a reader WATCHES while nothing else is
 * happening — they sent a message and are waiting for the agent to speak — and a
 * ten-frame stepped glyph read there as a terminal artefact rather than as the
 * app thinking.
 *
 * So the tail gets one soft mark that breathes: a core dot at full ink and a
 * halo that expands and fades around it on a 3.6s cycle. Two properties only —
 * transform and opacity — so it is compositor work with no layout and no paint
 * of the rows around it, and it is 14px of one hue with no ring, no pulse train
 * and no second signal beside it.
 *
 * It is licensed by the same predicate as the spinner (DESIGN.md §5, amended by
 * this issue): it renders ONLY while the session is genuinely computing or a
 * message is in transport to it, and gating remains the caller's job. Under
 * `prefers-reduced-motion` the halo holds still at its resting size — the mark
 * remains, the breathing does not.
 */
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

export function BreathingMark({
  size = 14,
  className,
}: {
  /** Box size in px. The core dot and halo are derived from it. */
  size?: number
  className?: string
}): JSX.Element {
  // Decorative: the tail's own label and timer carry the state for readers.
  return (
    <span
      aria-hidden
      data-testid="breathing-mark"
      className={cn('breath', className)}
      style={{ width: size, height: size }}
    />
  )
}
