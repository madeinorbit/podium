import type { missionProgress } from '@podium/client-core/viewmodels'
import { Users } from 'lucide-react'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/**
 * THE MISSION GAUGE — "the split readout" (POD-710).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BAR IS
 * ---------------------------------------------------------------------------
 *
 * One band per state, each carrying its OWN COUNT INSIDE ITSELF, sized by how
 * many tasks it holds. A band with no work in it does not exist — it is not a
 * 1px sliver, not a zero label, nothing. That is the whole premise: the bar can
 * only ever say things the mission is actually doing.
 *
 * It replaces a well that drew a tinted region, a floor rule and a three-word
 * legend for the same facts, so a one-task mission spent three devices saying
 * one thing. Now a mission of one running task is a single band reading
 * `1 RUNNING`, filling the track: one fact, one place. That is the operator's
 * complaint answered at the bar as well as in the arithmetic — the counting
 * half lives in `missionProgress` (one unit of work is one task; the root is
 * the container being measured, not a segment of it).
 *
 * Bands run done → running → blocked → to go, so the track fills from the left
 * as work lands and never reshuffles when one task changes state.
 *
 * ---------------------------------------------------------------------------
 * THE NARROW LADDER — the deck starts at 300px, so this is routine
 * ---------------------------------------------------------------------------
 *
 * Words inside a meter is what this shape costs, and the flight-deck column is
 * resizable from 300px, so a band running out of room is the normal case rather
 * than an edge case. It sheds the way the command bar sheds (DESIGN.md §5):
 * WORDS BEFORE DATA, DATA BEFORE MATERIAL, AND NOTHING IS EVER CLIPPED.
 *
 *   wide enough for `4 DONE` → the count and its noun
 *   wide enough for `4`      → the count alone, noun dropped whole (never
 *                              truncated — there is no `4 DON…` rung)
 *   narrower than that       → bare material: the colour, the hatch, the floor
 *                              rule. A band still says which state it is and
 *                              how much of the mission it is, by being there.
 *
 * The rungs are per BAND, not per column, because each band is its own
 * inline-size container: a mission that is mostly done keeps `6 DONE` legible
 * while its one-task neighbour is already down to `1`, which is the honest
 * reading of who has the room. It is CSS (`@container gauge-band`), not a
 * measured layout effect — see the `.gauge-band` block in styles.css, whose
 * thresholds are the text's own measure at 9px Geist Mono.
 *
 * At every rung, including bare material, the full sentence is on the gauge's
 * `aria-label` and `title`. The reading never degrades; only its typography
 * does.
 *
 * ---------------------------------------------------------------------------
 * COLOUR, TEXTURE, MOTION
 * ---------------------------------------------------------------------------
 *
 * Meters are data (DESIGN.md §5). Done takes Accent Blue (`--success`; Superade
 * has no green), running takes the working blue the spinner already wears
 * (`--live`), and the two are separated by more than hue: each band carries a
 * saturated 2px rule along its floor under a 26% tint of the same token, so the
 * ladder survives Daylight, where those two blues sit close together.
 *
 * BLOCKED TAKES NO HUE AT ALL. `--warning` IS `--attention` (#f5c518) in
 * Superade, so a warning-toned band would spend the one signal colour on work
 * that is asking nothing of the operator. It wears the same 135° diagonal a
 * blocked strip wears three rows below, one step denser because the strip has a
 * 28px row and the gauge has a 22px band — one texture for "stopped", in the
 * column and in the meter.
 *
 * MOTION GATES ON `working`, NOT ON `run`. The sweep is licensed by the
 * predicate the braille spinner is licensed by — an agent computing RIGHT NOW —
 * not by a task sitting in a stage (DESIGN.md §5, "The predicate, not the
 * device"). A mission parked in `in_progress` overnight with nothing attached
 * used to sweep all night, which is exactly the motion that outlives the
 * computing it depicts. This is the same gate `RowProgressMeter` uses, so the
 * row and the mission header can never disagree. `data-running` stays as the
 * task-stage fact, for anything that wants to know the mission has running
 * work; `data-working` is the motion fact.
 *
 * Fleet presence stays OUTSIDE the track, as a still neutral chip: `N live` is
 * not one more slice of the work, and presence asks nothing of the operator.
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
  // A band exists iff it holds work. `total === 0` is only reachable for a
  // mission whose root is itself archived; it leaves the empty groove, which is
  // the honest picture of a mission with nothing to measure.
  const bands = (
    [
      ['done', 'done', done],
      ['run', 'running', run],
      ['block', 'blocked', block],
      ['wait', 'to go', wait],
    ] as const
  ).filter(([, , count]) => count > 0)
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
      {/* THE TRACK, in the Paper shell's metrics (POD-725): the design's 24px
          well at radius 8 on the app ground, which is the same object the fleet
          chip beside it is. The READOUT inside it is unchanged and deliberately
          so — one band per state, each carrying its own count, none rendered for
          zero work. That is the operator's own pick from POD-716's three
          options; the theme dresses it, it does not get to re-decide it.
          The ground steps to --background rather than a translucent --secondary:
          on paper the old value sat between the two band tints and the track
          stopped reading as the thing the bands are IN. */}
      <span
        className="relative flex h-[24px] min-w-0 flex-1 items-center gap-[2px] overflow-hidden rounded-lg bg-background p-[2px] shadow-[inset_0_1px_2px_var(--carve-drop)]"
        data-testid="mission-gauge-track"
      >
        {bands.map(([state, word, count]) => (
          <span
            key={state}
            className={cn('gauge-band', state === 'block' && 'gauge-hatch')}
            data-testid="mission-gauge-band"
            data-s={state}
            style={{ flexGrow: count }}
          >
            {state === 'run' && working > 0 && (
              <span className="row-progress-sweep" aria-hidden="true" />
            )}
            <span className="gauge-band-text">
              <b className="gauge-band-count" data-w={Math.min(3, String(count).length)}>
                {count}
              </b>
              {/* The separating space belongs to the WORD, so shedding the word
                  sheds it too and a lone numeral is never left off-centre. */}
              <span className="gauge-band-word">{`\u00a0${word}`}</span>
            </span>
          </span>
        ))}
      </span>
      {/* Fleet presence sits BESIDE the track, never inside it — `N live` must
          not read as one more progress band. The design makes it the same 24px
          well rather than a raised chip: on paper --chip IS the card, so a
          bordered white chip beside a recessed track read as two unrelated
          objects, and the rim was doing work the tone step already does. */}
      <span
        className="shell-type-micro flex h-[24px] flex-none items-center gap-1.5 rounded-lg bg-background px-[9px] font-mono tabular-nums text-text-dim"
        data-testid="mission-live-chip"
      >
        <Users size={12} aria-hidden="true" className="text-text-faint" />
        {live} live
      </span>
    </div>
  )
}
