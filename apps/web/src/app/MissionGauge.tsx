import type { missionProgress } from '@podium/client-core/viewmodels'
import { Users } from 'lucide-react'
import type { JSX } from 'react'

/**
 * THE MISSION GAUGE — one well, three parts (POD-725).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE INSTRUMENT IS
 * ---------------------------------------------------------------------------
 *
 * A 24px WELL, one tier below the column it sits in, holding:
 *
 *   THE EXTENT  a region from the left edge at the done+running fraction,
 *               filled with `--live` at 16% — a tint you would struggle to
 *               name the hue of, and deliberately not a bar.
 *   THE DATUM   a 2px rule in solid `--live` along the FLOOR of that region
 *               and nowhere else. This is the precise edge; the tint above it
 *               is only the rough reading.
 *   THE READING the counts, in words, INSIDE the well, riding over the tint at
 *               full-strength `--foreground`.
 *
 * The arrangement exists so the words are never knocked out of a fill. A meter
 * that saturates its filled part has to choose between a legible number and a
 * visible quantity; a tint under full-strength ink owes nothing to either — the
 * exact figure and the rough extent are readable in the same glance, which is
 * the whole reason the reading lives in the well rather than beside it.
 *
 * It replaces the split readout's row of per-state bands (POD-710). That shape
 * answered the right complaint — one fact, one place — but it answered it by
 * making each band a saturated surface with knocked-out text, and a column of
 * saturated surfaces is what the Paper shell is spending its restraint to
 * avoid. The complaint is answered here by the reading: a mission of one
 * running task says `0 done · 1 running` once, in one instrument. The counting
 * itself never moved — `missionProgress` owns it (one unit of work is one task;
 * the root is the container being measured, not a segment of it).
 *
 * THE HUE IS A STATE, NEVER `--issue`. Progress is not an identity, and the
 * mission this gauge measures is already named by the colour of the column
 * around it — an issue-coloured meter would say "which" where the operator is
 * asking "how far". Superade has no green, so forward motion is the working
 * blue the spinner already wears, in both themes.
 *
 * BLOCKED AND TO-GO ARE NOT DRAWN, ONLY SAID. They are the part of the well the
 * extent has not reached, and they take no hue: `--warning` IS `--attention`
 * (#f5c518) in Superade, so a warning-toned region would spend the one signal
 * colour on work that is asking the operator for nothing. The words carry them,
 * and the strips three rows below carry the reason.
 *
 * THE NARROW LADDER. The deck is resizable from 300px, so the reading can run
 * out of well. It ellipses rather than sheds — losing the tail of a sentence is
 * legible as loss, where a silently dropped clause is not — and the whole
 * sentence is on the gauge's `aria-label` and `title` at every width, so the
 * reading itself never degrades, only its typography.
 *
 * MOTION GATES ON `working`, NOT ON `run`. The sweep is licensed by the
 * predicate the braille spinner is licensed by — an agent computing RIGHT NOW —
 * not by a task sitting in a stage (DESIGN.md §5, "The predicate, not the
 * device"). A mission parked in `in_progress` overnight with nothing attached
 * used to sweep all night, which is exactly the motion that outlives the
 * computing it depicts. This is the same gate `RowProgressMeter` uses, so the
 * row and the mission header can never disagree. It sweeps the EXTENT, because
 * the extent is the part of the mission the computing is happening inside.
 * `data-running` stays as the task-stage fact, for anything that wants to know
 * the mission has running work; `data-working` is the motion fact.
 *
 * Fleet presence stays OUTSIDE the well, as a still neutral chip: `N live` is
 * not one more slice of the work, and presence asks nothing of the operator. It
 * is cut as the same 24px well, though: a raised chip beside a recessed
 * instrument read as two kinds of object saying one kind of thing, and on paper,
 * where `--chip` IS the card, it read as no object at all.
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
  const { total, done, run, block, wait } = progress
  const reading =
    [
      `${done} of ${total} task${total === 1 ? '' : 's'} done`,
      run > 0 ? `${run} running` : null,
      block > 0 ? `${block} blocked` : null,
      wait > 0 ? `${wait} to go` : null,
    ]
      .filter(Boolean)
      .join(', ') +
    ` · ${live} agent${live === 1 ? '' : 's'} live` +
    `${working > 0 ? `, ${working} working` : ''}`
  // The reading INSIDE the well is the same facts without the sentence around
  // them: `done` is always said (a mission with nothing done still has a figure
  // to report), every other state only when it holds work — the split readout's
  // premise, kept. `total === 0` is only reachable for a mission whose root is
  // itself archived, and reads `0 done` over an empty well, which is the honest
  // picture of a mission with nothing to measure.
  const figures = [
    `${done} done`,
    run > 0 ? `${run} running` : null,
    block > 0 ? `${block} blocked` : null,
    wait > 0 ? `${wait} to go` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  // Work in hand: what has landed plus what is moving. Everything else is the
  // well the extent has not reached.
  const extent = total === 0 ? '0%' : `${((done + run) / total) * 100}%`
  return (
    <div
      className="mt-3 flex items-center gap-2"
      data-testid="mission-gauge"
      data-running={run > 0 ? 'true' : 'false'}
      data-working={working > 0 ? 'true' : 'false'}
      role="img"
      aria-label={reading}
      title={reading}
    >
      <span
        className="relative flex h-6 min-w-0 flex-1 items-center overflow-hidden rounded-lg bg-background shadow-[inset_0_1px_2px_var(--carve-drop)]"
        data-testid="mission-gauge-track"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-live/16"
          style={{ width: extent }}
          data-testid="mission-gauge-extent"
        >
          {run > 0 && working > 0 && <span className="row-progress-sweep" aria-hidden="true" />}
        </span>
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-[2px] bg-live"
          style={{ width: extent }}
          data-testid="mission-gauge-datum"
        />
        {/* `relative` is load-bearing: the reading rides OVER the tint and the
            sweep rather than being covered by them. */}
        <span
          className="shell-type-micro relative truncate px-2.5 font-mono tabular-nums text-foreground"
          data-testid="mission-gauge-reading"
        >
          {figures}
        </span>
      </span>
      <span
        className="shell-type-micro flex h-6 flex-none items-center gap-1.5 rounded-lg bg-background px-[9px] font-mono tabular-nums text-text-dim shadow-[inset_0_1px_2px_var(--carve-drop)]"
        data-testid="mission-live-chip"
      >
        <Users size={12} aria-hidden="true" />
        {live} live
      </span>
    </div>
  )
}
