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
 * inset, drawn inside the row's existing bottom padding. It is absolutely
 * positioned, so a row that grows one costs exactly zero pixels of height and
 * a list of thirty rows keeps one even rhythm whether every row has a meter or
 * none does. Because it starts under the TITLE rather than at the row's edge,
 * it can never be misread as a divider between two rows.
 *
 * Reading it is one saccade down the column: the meters are all the same
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
 * status line goes `--motion-working` blue while an agent runs and
 * `--motion-total` grey when the work is done. The meter speaks it back —
 * finished work in the settled grey, live work in the working blue, everything
 * untouched left as the faint trough — so the row says one thing in one
 * language rather than introducing a second palette for the same states.
 *
 * The rejected alternative was the artifact's done-in-green, which Superade has
 * no green for; its honest translation is the theme's success accent, and in
 * Daylight that is #1d4ed8 against a running #2a62f0 — two blues a 3px bar
 * cannot separate. Grey against blue survives every theme, and it leaves the
 * MOVING part as the only coloured thing in the instrument, which is precisely
 * where the operator asked the eye to go.
 *
 * BLOCKED gets no segment of its own. Three greys inside three pixels is not a
 * reading; blocked work is not moving, and the trough is where not-moving
 * belongs at this scale. The count survives in the meter's own tooltip, and the
 * Flight Deck names which task is blocked and by what — one fact, one place.
 *
 * The RUNNING segment carries a slow sheen travelling along it, which is the
 * part the operator asked to move. It is gated on the same predicate as the
 * braille spinner — an agent on this row actually computing, not merely a task
 * parked in `in_progress` — so the row goes completely still the moment the
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
import type { JSX } from 'react'
import type { MissionProgress } from '@podium/client-core/viewmodels'
import { cn } from '@/lib/utils'

/**
 * The smallest mission that gets a meter.
 *
 * `missionProgress` counts the root as a task, so `2` means "the row speaks for
 * at least one task besides itself" — the exact condition under which a
 * done/total is a real fraction rather than a boolean wearing a bar.
 */
export const ROW_PROGRESS_MIN_TASKS = 2

export function rowProgressLabel(progress: MissionProgress): string {
  return [
    `${progress.total} tasks`,
    `${progress.done} done`,
    `${progress.run} running`,
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
      // Inside the row's bottom padding: -2px puts the 3px rule below the status
      // line's descender box without adding a pixel to the row. The trough is
      // the ink ramp's faintest grey at a quarter strength, so it reads as
      // "there is a length here" in both themes without becoming a divider.
      className="pointer-events-none absolute inset-x-0 -bottom-[2px] flex h-[3px] overflow-hidden rounded-full bg-text-faint/25"
    >
      <span
        data-segment="done"
        className={cn(segment, 'bg-[var(--motion-total)]')}
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
    </span>
  )
}
