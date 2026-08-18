import { type missionProgress, missionCrewLabel } from '@podium/client-core/viewmodels'
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
 * one thing. Now a mission of one started task is a single band reading
 * `1 UNDERWAY`, filling the track: one fact, one place. That is the operator's
 * complaint answered at the bar as well as in the arithmetic — the counting
 * half lives in `missionProgress` (one unit of work is one task; the root is
 * the container being measured, not a segment of it).
 *
 * Bands run done → in review → underway → stalled → blocked → to go, so
 * review-stage work cannot masquerade as execution when the fleet chip correctly
 * says zero agents. The track fills from the left as work lands.
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
 * Meters are data (DESIGN.md §5). Done takes `--success` — a real green in the
 * Nova and Podium presets, Royal Blue in Daylight, which has none — and running
 * takes the working blue the spinner already wears (`--live`).
 *
 * WEIGHT IS WHAT SEPARATES THEM, not hue: DONE IS THE GAUGE'S ONLY SOLID BAND
 * and everything unfinished is a tint over a saturated floor rule. Finished
 * work is settled, so it is dense; work in flight is light and carries the
 * motion. That holds in Daylight, where done and running are two blues and hue
 * alone could not carry it, and it reinforces the hue everywhere else.
 *
 * THE BAND IS CALLED `UNDERWAY`, NOT `RUNNING` AND NO LONGER `IN PROGRESS`. In
 * `missionProgress` the `run` bucket counts tasks whose STAGE says work has
 * begun, while the motion gates on `working` — a session actually computing.
 * Those are two different facts, and a band reading `3 RUNNING` sitting
 * perfectly still claimed one while measuring the other; the marching cells say
 * whether anything is happening inside it.
 *
 * It took the stage's own name, `IN PROGRESS`, for as long as the bucket was one
 * stage. It is three now — `planning`, `in_progress`, `shipping` (POD-1181,
 * `UNDERWAY` in mission.ts) — because the remainder band's word is `TO GO`, i.e.
 * "nobody has picked this up", and it was saying that about a task with an agent
 * designing in it. A band covering three stages cannot wear one stage's label, so
 * it takes the word all three have in common and none of them owns.
 *
 * `STALLED` IS `UNDERWAY` WITH THE SEAT EMPTY (POD-1314). A task whose stage says
 * work began but which has no open session anywhere under it is not executing,
 * and this bar said `1 UNDERWAY` about one beside a chip reading `0 agents`, a
 * strip reading `Retired` and a `no agent` seat — four devices on one header,
 * three of them right. It is its own band rather than a shade of the run band
 * because it is a different state of the WORK, not a different intensity of the
 * same one: `presenceNote` already reads it as `Agent left · choose a handoff`.
 *
 * ITS MATERIAL IS THE RUN BAND'S, DRAINED, ON A DOTTED FLOOR RULE. Half the blue
 * in the ground says "this is started work"; the DOTTED rule is the spine's one
 * reserved meaning for an empty seat — the same rim the `no agent` chip wears
 * six pixels above it (`SeatChip`, FlightDeck.tsx) — so the gauge borrows the
 * column's vocabulary instead of inventing a sixth colour. It carries no march:
 * motion is licensed by an agent computing, and the whole claim of this band is
 * that there is not one.
 *
 * BLOCKED TAKES NO HUE AT ALL. `--warning` IS `--attention` (#f5c518) in
 * Superade, so a warning-toned band would spend the one signal colour on work
 * that is asking nothing of the operator. It wears the same 135° diagonal a
 * blocked strip wears three rows below, one step denser because the strip has a
 * 28px row and the gauge has a 22px band — one texture for "stopped", in the
 * column and in the meter.
 *
 * MOTION GATES ON `working`, NOT ON `run`. The march is licensed by the
 * predicate the braille spinner is licensed by — an agent computing RIGHT NOW —
 * not by a task sitting in a stage (DESIGN.md §5, "The predicate, not the
 * device"). A mission parked in `in_progress` overnight with nothing attached
 * used to animate all night, which is exactly the motion that outlives the
 * computing it depicts. This is the same gate `RowProgressMeter` uses, so the
 * row and the mission header can never disagree. `data-running` stays as the
 * task-stage fact, for anything that wants to know the mission has running
 * work; `data-working` is the motion fact.
 *
 * IT MARCHES, IT DOES NOT SWEEP. `.row-progress-sweep` is a full-height sheen
 * travelling over the whole segment — right on the sidebar's 3px rule, wrong
 * here, because this band has WORDS in it and the sheen washed across them
 * twice a second. `.gauge-band-march` runs cells of the band's own blue along
 * the segment instead, under the count rather than over it. The sidebar keeps
 * the sweep; its meter has nothing to wash out.
 *
 * IT GLIDES (POD-1177). The march used to advance in `steps(8, end)`, on the
 * reasoning that a meter speaking the spinner's grammar should step as the
 * spinner steps. Stepping a ten-frame GLYPH is smooth — each frame is a whole
 * new character. Stepping a POSITION is not: eight frames in 1.3s left 88% of
 * rendered frames unchanged and moved the light a sixth of the band at a time,
 * which reads as dropped frames rather than as cadence, and dropped frames are
 * how this app says the machine is in trouble. The cells now travel every
 * frame, on a compositor transform rather than a repainted background, at a
 * constant speed the band's width no longer changes. The material — the 6/3
 * cells, the 42% blue, the gate on `working` — is exactly what it was; see the
 * rule in styles.css for the mechanics.
 *
 * NOTHING TO MEASURE is a state, not a gap. `total === 0` (a closed root, or
 * one whose members have all left) used to paint an empty groove beside
 * "0 agents", which reads as broken. It gets one neutral band saying NO TASKS —
 * in the `to go` ground, never a success colour: nothing is done, there is
 * simply nothing to count.
 *
 * Fleet presence stays OUTSIDE the track, as a still neutral chip. The chip
 * says who is computing when someone is (`N working`), otherwise who is on
 * the task (`N agents`) — never `live`, which parked agents are not.
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
  const { total, done, run, review, stall, block, wait } = progress
  const crew = missionCrewLabel(live, working)
  const work =
    total === 0
      ? 'No tasks'
      : [
          `${done} of ${total} task${total === 1 ? '' : 's'} done`,
          run > 0 ? `${run} underway` : null,
          review > 0 ? `${review} in review` : null,
          stall > 0 ? `${stall} stalled` : null,
          block > 0 ? `${block} blocked` : null,
          wait > 0 ? `${wait} to go` : null,
        ]
          .filter(Boolean)
          .join(', ')
  const reading = `${work} · ${crew}`
  // A band exists iff it holds work — with one exception, and it is not an
  // exception to that rule: a mission with NOTHING to count gets the `none`
  // band, which holds no work and says so. Everything else would be an empty
  // groove, and an empty groove reads as a broken gauge.
  const bands =
    total === 0
      ? ([['none', 'no tasks', 0]] as const)
      : (
          [
            ['done', 'done', done],
            ['review', 'in review', review],
            ['run', 'underway', run],
            ['stall', 'stalled', stall],
            ['block', 'blocked', block],
            ['wait', 'to go', wait],
          ] as const
        ).filter(([, , count]) => count > 0)
  return (
    <div
      className="flex min-w-0 items-center gap-2"
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
        className="relative flex h-[26px] min-w-0 flex-1 items-center gap-[2px] overflow-hidden rounded-lg bg-background p-[2px] shadow-[inset_0_1px_2px_var(--carve-drop)]"
        data-testid="mission-gauge-track"
      >
        {bands.map(([state, word, count]) => (
          <span
            key={state}
            className={cn('gauge-band', state === 'block' && 'gauge-hatch')}
            data-testid="mission-gauge-band"
            data-s={state}
            // The empty band holds no work, so its weight is not its count —
            // it takes the whole track, because "nothing to count" is not a
            // slice of anything.
            style={{ flexGrow: state === 'none' ? 1 : count }}
          >
            {state === 'run' && working > 0 && (
              <span className="gauge-band-march" aria-hidden="true" />
            )}
            <span className="gauge-band-text">
              {/* The empty band counts nothing \u2014 it exists to say there is
                  nothing to count \u2014 so it carries the word alone. */}
              {state !== 'none' && (
                <b className="gauge-band-count" data-w={Math.min(3, String(count).length)}>
                  {count}
                </b>
              )}
              {/* The separating space belongs to the WORD, so shedding the word
                  sheds it too and a lone numeral is never left off-centre. */}
              <span className="gauge-band-word">{state === 'none' ? word : `\u00a0${word}`}</span>
            </span>
          </span>
        ))}
      </span>
      {/* Fleet sits BESIDE the track, never inside it — crew is not one more
          progress band. The design makes it the same 24px well rather than a
          raised chip: on paper --chip IS the card, so a bordered white chip
          beside a recessed track read as two unrelated objects, and the rim
          was doing work the tone step already does. */}
      <span
        className="shell-type-micro flex h-[26px] flex-none items-center gap-1.5 rounded-lg bg-background px-[9px] font-mono tabular-nums text-text-dim"
        data-testid="mission-live-chip"
      >
        <Users size={12} aria-hidden="true" className="text-text-faint" />
        {crew}
      </span>
    </div>
  )
}
