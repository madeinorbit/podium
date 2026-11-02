import { type MissionProgress, missionProgressLabel } from '@podium/client-core/values'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { observeRowProgressSweep } from './row-progress-sweep'

/**
 * The smallest mission that gets a meter.
 *
 * `missionProgress` counts UNITS OF WORK, and one unit is one task in the
 * mission — the root is the container being measured, not a segment of it
 * (POD-710). So `2` now means literally two tasks, which is the exact condition
 * under which a done/total is a real fraction rather than a boolean wearing a
 * bar. The number did not move; what it counts did, and it moved in the
 * direction that makes the threshold honest. A row whose whole mission is one
 * task used to arrive here as `total: 2` — the root plus its only child — and
 * drew a two-segment meter over what was always one thing.
 */
export const ROW_PROGRESS_MIN_TASKS = 2

export function rowProgressLabel(progress: MissionProgress): string {
  return missionProgressLabel(progress)
}

/**
 * The row's baseline rule. Renders nothing for a row with no real subtree.
 *
 * @param working Is an agent on this row COMPUTING right now (the row's motion
 *   phase, the same gate the braille spinner uses)? Not "does it have a task in
 *   progress" — a task can sit in `in_progress` all night with nothing running,
 *   and a moving meter over that is the one lie this grammar must not tell.
 */
export function RowProgressMeter({
  progress,
  working,
}: {
  progress: MissionProgress
  working: boolean
}): JSX.Element | null {
  if (progress.total < ROW_PROGRESS_MIN_TASKS) return null
  const pct = (n: number): string => `${(n / progress.total) * 100}%`
  const label = rowProgressLabel(progress)
  const segment =
    'h-full transition-[width] duration-[450ms] ease-out motion-reduce:transition-none'
  return (
    <span
      data-testid="row-progress"
      data-total={progress.total}
      data-working={working ? 'true' : 'false'}
      role="img"
      aria-label={label}
      title={label}
      // Three pixels and a 2px radius (3a): at 2px square-ended, sitting in the
      // row's own text block, the empty part read as a stray underline. The
      // trough steps up to `--border-strong`, because an empty meter has to be
      // visible enough to say "this row is seven tasks, none of them started".
      // The row rule below it (POD-1078) is a different mark on every axis that
      // matters — 1px, full-bleed, soft, and outside the text block the meter
      // is indented into — so the two do not read as the same instrument.
      className="pointer-events-none flex h-[3px] w-full overflow-hidden rounded-[2px] bg-border-strong"
    >
      <span
        data-segment="done"
        // Settled work reads in `--text-dim`: one step up from the trough it
        // sits in, so the boundary between done and not-done is legible at 3px,
        // and one step down from the row's own body ink, so a full bar never
        // out-reads the title above it.
        className={cn(segment, 'bg-text-dim')}
        style={{ width: pct(progress.done) }}
      />
      <span
        data-segment="run"
        // `--live` is the theme's working blue: identical to `--motion-working`
        // on every dark surface (#6f9dff), and its legible counterpart on paper
        // — the same token the spinner and the counting timer already wear.
        className={cn(segment, 'relative overflow-hidden bg-live')}
        style={{ width: pct(progress.working) }}
      >
        {working && progress.working > 0 && (
          <span ref={observeRowProgressSweep} className="row-progress-sweep" aria-hidden="true" />
        )}
      </span>
    </span>
  )
}
