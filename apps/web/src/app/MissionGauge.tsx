import type { missionProgress } from '@podium/client-core/viewmodels'
import { Users } from 'lucide-react'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/**
 * THE MISSION GAUGE — progress and fleet as adjacent instruments (round 3 §3, §11).
 *
 * The reading used to sit BESIDE the track, and the fleet ("21 live / 0 coords")
 * a line below it as a pair of mono footnotes. Three facts, three places, none
 * of them composed. The progress facts now share one carved well: the extent is
 * the well's own ground and the reading sits inside it. Fleet presence is a
 * separate chip beside the well, so `N live` cannot be mistaken for one more
 * progress segment.
 *
 * The extent is drawn twice on purpose, the way a real gauge is — a soft tinted
 * REGION says roughly how far, and a saturated 2px rule along the floor says
 * exactly where it ends. That is also what buys the contrast: the words sit over
 * a 22% tint rather than over a solid fill, so they stay full-strength ink.
 *
 * COLOUR. Meters are data (DESIGN.md §5). Done takes Accent Blue, running takes
 * the working blue the spinner already uses, and BLOCKED TAKES NO HUE AT ALL:
 * `--warning` IS `--attention` in Superade, so the old warning-toned segment was
 * spending the one signal colour on work that is asking nothing. It reads as the
 * same diagonal hatch a blocked strip wears instead — one idea, both places.
 *
 * MOTION. The running segment carries the same slow sweep as the sidebar's
 * progress rule whenever the mission has running issues. This is task progress,
 * not an agent-presence meter: it keeps moving while work is between model
 * turns. The live chip stays neutral and still, because presence asks nothing
 * of the operator.
 */
export function MissionGauge({
  progress,
  live,
  working,
}: {
  progress: ReturnType<typeof missionProgress>
  live: number
  working: number
}): JSX.Element {
  const { total, done, run, block } = progress
  const pct = (n: number): string => `${total === 0 ? 0 : (n / total) * 100}%`
  const words = [`${done} done`, `${run} running`, block > 0 ? `${block} blocked` : null]
    .filter(Boolean)
    .join(' · ')
  const reading =
    `${done} of ${total} task${total === 1 ? '' : 's'} done, ${run} running` +
    `${block > 0 ? `, ${block} blocked` : ''} · ${live} agent${live === 1 ? '' : 's'} live` +
    `${working > 0 ? `, ${working} working` : ''}`
  const segment = (width: string, tone: string, hatch = false, animated = false): JSX.Element => (
    <span
      className={cn(
        'relative h-full overflow-hidden transition-[width] duration-300 motion-reduce:transition-none',
        tone,
        hatch && 'deck-hatch',
      )}
      style={{ width }}
    >
      {animated && <span className="row-progress-sweep" />}
    </span>
  )
  return (
    <div
      className="mt-3 flex items-center gap-2"
      data-testid="mission-gauge"
      data-running={run > 0 ? 'true' : 'false'}
      role="img"
      aria-label={reading}
      title={reading}
    >
      <span
        className="relative flex h-[22px] min-w-0 flex-1 items-center overflow-hidden rounded-lg bg-secondary/70 shadow-[inset_0_1px_2px_var(--carve-drop)]"
        data-testid="mission-gauge-track"
      >
        {/* The region: the well's ground, tinted as far as the work has come. */}
        <span aria-hidden className="absolute inset-0 flex">
          {segment(pct(done), 'bg-success/22')}
          {segment(pct(run), 'bg-live/22', false, run > 0)}
          {segment(pct(block), 'bg-transparent', true)}
        </span>
        {/* The floor rule: the same datum, said exactly. */}
        <span aria-hidden className="absolute inset-x-0 bottom-0 flex h-[2px]">
          {segment(pct(done), 'bg-success')}
          {segment(pct(run), 'bg-live')}
          {segment(pct(block), 'bg-text-faint')}
        </span>
        <span className="shell-type-micro relative min-w-0 flex-1 truncate px-2.5 font-mono tabular-nums text-foreground">
          {words}
        </span>
      </span>
      <span
        className="shell-type-micro flex h-[22px] flex-none items-center gap-1.5 rounded-md border border-hairline-bar bg-chip px-2 font-mono tabular-nums text-text-dim"
        data-testid="mission-live-chip"
      >
        <Users size={10} aria-hidden="true" className="text-text-faint" />
        {live} live
      </span>
    </div>
  )
}
