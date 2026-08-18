/**
 * THE PER-ENTRY PROGRESS INDICATOR (POD-516 round 3, left sidebar).
 *
 * "what i want is a progress bar or another graphically smart progress
 *  indicator PER sidebar entry (if it makes sense e.g. multiple issues or
 *  progress known). the working part of the bar can be animated"
 *
 * The mission-wide instrument that used to sit at the top of this column is
 * gone. Progress belongs to the row whose work it describes, so this is the
 * artifact's segmented `progress()` meter at the only scope where it is a fact
 * about ONE thing the operator can click.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS, AND WHY IT COSTS NO HEIGHT
 * ---------------------------------------------------------------------------
 *
 * A worklist row is already a dense object: a 30px identity square, a title
 * line carrying the fleet stack and the need pill, and a mono status line
 * carrying the state word, the timer and the git stamp. There is no free
 * column left on either line — an inline meter would have to push the status
 * phrase into an ellipsis, and it would land at a different x on every row,
 * which is the one thing a scannable list cannot afford.
 *
 * So the meter is not a chip on a line: it is the row's own BASELINE RULE,
 * spanning the text column from the title's left edge to the row's right
 * inset, as the third line of the row's text block.
 *
 * IT COSTS HEIGHT NOW (POD-1057). It used to hang in the row's bottom padding,
 * so a metered row and a bare one were both 44px — a trick that only read as
 * "belongs to the row above" because a hairline separated them. In flow it is
 * unambiguous whatever the rules do, and the height is worth it: a metered row
 * is 54px against a bare row's 46px (POD-1078 put both back on the mock's 7px
 * padding and its 1px rule), and the difference itself says "this row has a
 * subtree".
 *
 * Reading it is still one saccade down the column: the meters are all the same
 * length and all at the same x, so the eye compares fill, not geometry.
 *
 * ---------------------------------------------------------------------------
 * WHEN IT EARNS ITS PLACE
 * ---------------------------------------------------------------------------
 *
 * THE RULE: two or more tasks in the mission, or nothing. See {@link
 * ROW_PROGRESS_MIN_TASKS}.
 *
 * A row that is one issue with one agent has no fraction — it is 0% until the
 * moment it is 100% — and a bar that can only ever show those two states says
 * nothing the status word ("Running", "Done") has not already said in a word.
 * A row that is an epic with a single sub-issue is the same row wearing a
 * hierarchy, and since POD-710 it counts as the one task it is.
 * The operator qualified the ask with "if it makes sense", and this is the
 * qualification: the meter appears exactly when there is a real done/total,
 * i.e. when the row is speaking for a subtree that the flat column gives no
 * rows of its own.
 *
 * A multi-task mission where nothing has started yet DOES keep its meter, empty
 * trough and all. Its length is the information — "this row is seven tasks" —
 * and a meter that appeared only once the first task moved would make the row
 * change shape for a reason unrelated to what the operator is looking for.
 *
 * ---------------------------------------------------------------------------
 * COLOUR FOR STATE, MOTION FOR ACTIVITY
 * ---------------------------------------------------------------------------
 *
 * Nothing here is amber. A progress meter asks nothing of the operator, and
 * yellow is reserved for what does (DESIGN.md §2, The Signal Rule).
 *
 * TWO TONES AND A GHOST, not the artifact's four colours. This row already owns
 * a colour vocabulary for exactly these facts, six pixels above the meter: its
 * status word goes `--live` blue while an agent runs and drops back to the ink
 * ramp when the work is done. The meter speaks it back — finished work in the
 * settled `--text-faint`, live work in the working blue, everything untouched
 * left as the `--hairline-soft` trough — so the row says one thing in one
 * language rather than introducing a second palette for the same states.
 *
 * The rejected alternative was the artifact's done-in-green, which Superade has
 * no green for; its honest translation is the theme's success accent, and in
 * Daylight that is #1d4ed8 against a running #2a62f0 — two blues a 2px bar
 * cannot separate. Grey against blue survives every theme, and it leaves the
 * MOVING part as the only coloured thing in the instrument, which is precisely
 * where the operator asked the eye to go.
 *
 * BLOCKED gets no segment of its own. Three greys inside three pixels is not a
 * reading; blocked work is not moving, and the trough is where not-moving
 * belongs at this scale. The count survives in the meter's own tooltip, and the
 * Flight Deck names which task is blocked and by what — one fact, one place.
 *
 * STALLED gets none either, on the same rule, and the RUN SEGMENT SHRANK TO PAY
 * FOR IT (POD-1314). Started work with nobody on it used to be inside the blue,
 * so this rule ran a live-blue segment across a mission whose every agent had
 * exited — the row's own status word six pixels above it saying `Retired` at the
 * same time. It is not moving, so it belongs in the trough with the rest of what
 * is not moving; the blue is now only ever work something is actually on. The
 * count is in the tooltip and the Flight Deck names which task lost its agent.
 *
 * The UNDERWAY segment — every stage that says work has begun (POD-1181) —
 * carries a slow sheen travelling along it, which is the part the operator asked
 * to move. It is gated on the same predicate as the braille spinner — an agent on
 * this row actually computing, not merely a task
 * parked in a started stage — so the row goes completely still the moment the
 * fleet stops, and stillness stays legible as "this is waiting for you".
 * DESIGN.md §5 names the spinner as the only perpetual motion; this is not a
 * second signal beside it but the same fact rendered as the texture of the
 * segment that fact is about, on a row that is already showing the spinner on
 * its square. Reduced motion drops the sheen and the width transitions both.
 *
 * Segment widths TRANSITION (0.45s) rather than jumping: a task finishing is a
 * real change and the meter should be seen to move, which is also the only way
 * a glance that lands mid-change reads the right number.
 */

import type { MissionProgress } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

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
  return [
    `${progress.total} tasks`,
    `${progress.done} done`,
    `${progress.run} underway`,
    ...(progress.review > 0 ? [`${progress.review} in review`] : []),
    ...(progress.stall > 0 ? [`${progress.stall} stalled`] : []),
    ...(progress.block > 0 ? [`${progress.block} blocked`] : []),
    `${progress.wait} waiting`,
  ].join(' · ')
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
        style={{ width: pct(progress.run) }}
      >
        {working && <span className="row-progress-sweep" aria-hidden="true" />}
      </span>
      {progress.review > 0 && (
        <span
          data-segment="review"
          className={cn(segment, 'bg-attention')}
          style={{ width: pct(progress.review) }}
        />
      )}
    </span>
  )
}

/**
 * THE SAME INSTRUMENT, INSIDE THE RAIL'S TILE (POD-1178, design 3b).
 *
 * The collapsed column has no text block to hang a baseline rule under, so the
 * meter moves ONTO the mark: a 2px rule inset into the foot of the 36×32 tile,
 * which is the only free surface a 58px column has. Everything that makes the
 * wide meter honest is shared rather than restated — the same `MissionProgress`,
 * the same {@link ROW_PROGRESS_MIN_TASKS} threshold, the same
 * {@link rowProgressLabel} reading, the same two tones (settled `--text-dim`,
 * live `--live`) over the same trough.
 *
 * TWO SEGMENTS, NOT THREE. The wide rule spends ~180px and can afford to split
 * `review` out in amber; this one has ~26px, where a third band is a smudge —
 * and amber inside a tile the operator scans for the corner badge would compete
 * with the one mark in this column that is allowed to ask for something. Review
 * work reads as not-yet-done here, and the tooltip still names the count.
 *
 * NO SWEEP EITHER: a travelling sheen needs length to be seen travelling, and
 * the rail already says "an agent is computing" on this tile through the badge
 * the wide row shows in the same place.
 */
export function RailProgressMeter({ progress }: { progress: MissionProgress }): JSX.Element | null {
  if (progress.total < ROW_PROGRESS_MIN_TASKS) return null
  const pct = (n: number): string => `${(n / progress.total) * 100}%`
  return (
    <span
      data-testid="rail-progress"
      data-total={progress.total}
      role="img"
      aria-label={rowProgressLabel(progress)}
      className="pointer-events-none absolute right-[5px] bottom-[4px] left-[5px] z-[1] flex h-[2px] overflow-hidden rounded-[1px] bg-border-strong"
    >
      <span
        data-segment="done"
        className="h-full bg-text-dim transition-[width] duration-[450ms] ease-out motion-reduce:transition-none"
        style={{ width: pct(progress.done) }}
      />
      <span
        data-segment="run"
        className="h-full bg-live transition-[width] duration-[450ms] ease-out motion-reduce:transition-none"
        style={{ width: pct(progress.run) }}
      />
    </span>
  )
}
