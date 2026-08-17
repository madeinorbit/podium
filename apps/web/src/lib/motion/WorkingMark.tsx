/**
 * THE WORKING MARK — the one mark the app uses to say "an agent is computing
 * right now", on every surface: sidebar rows, tabs, corner badges, pending
 * buttons, and the end of a transcript.
 *
 * It is the braille cell the status strip used to SPIN, held still and lit in a
 * travelling wave instead. Eight dots, two columns of four; one CSS animation
 * with eight staggered delays walks the light down the cell. No rotation, no
 * canvas, no frame loop — and no beat you could point at, which is what lets
 * the same mark sit inside a dense mono row AND be stared at for a minute at
 * the tail of a feed without reading as a terminal artefact. Before this there
 * were two marks for one fact (a stepped braille glyph in rows, a breathing
 * canvas ring at the tail); a tab and the transcript it leads to now describe
 * the same working session with the same shape.
 *
 * It renders ONLY while an agent is actually computing (motionPhase ===
 * 'working', or a message in transport to one) — gating stays the caller's job,
 * exactly as it was for the spinner.
 */
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/** Cell geometry, verbatim from the design (viewBox 66×100): two columns of
 *  four. Order is the wave's path — left, right, one row down, repeat. */
const DOTS: readonly (readonly [number, number])[] = [
  [17, 18],
  [49, 18],
  [17, 39],
  [49, 39],
  [17, 61],
  [49, 61],
  [17, 82],
  [49, 82],
]

export function WorkingMark({
  size = 12,
  className,
}: {
  /** Cell HEIGHT in px; width follows the 66:100 cell (≈0.66×). 11 in a corner
   *  badge, 12–13 in sidebar/menu rows, 15 on tabs and tool lines, 24 at the
   *  tail of the feed. */
  size?: number
  className?: string
}): JSX.Element {
  // Small cells get FATTER dots: at 12px tall a 9.5-unit dot is a grey smudge
  // and the wave has nothing to travel across. Ladder verbatim from the design.
  const r = size >= 18 ? 9.5 : size >= 14 ? 10.5 : 11
  return (
    // Decorative: the timer, label or row beside it carries the state for readers.
    <svg
      aria-hidden="true"
      focusable="false"
      data-testid="working-mark"
      viewBox="0 0 66 100"
      width={Math.round(size * 0.66)}
      height={size}
      className={cn('pod-mark', className)}
    >
      {DOTS.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  )
}
