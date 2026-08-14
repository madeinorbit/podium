import type { MotionPhase } from '@podium/client-core/viewmodels'
import { ArrowDownToLine } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type {
  CSSProperties,
  JSX,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { UnreadDot, unreadTitleClass } from '@/components/UnreadMark'
import { FLOW_CSS } from '@/lib/issueColors'
import { usePhaseMorph } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { RowShortcutBadge } from './RowShortcutBadge'

/** The identity gutter: the row's number, right-aligned so a column of three-
 *  and four-digit refs shares one right edge (3a). 26px is exactly wide enough
 *  for four mono digits at the micro role. */
export const ID_GUTTER_W = 26

/** The line-1 meta column: the timer, the relative stamp, or the tuck chip.
 *  FIXED, and right-aligned inside itself, so every row's title ellipsizes at
 *  the same x and the times tabulate down the column (3a). */
export const META_COL_W = 56

/** The status lockup's own ink (3a).
 *
 *  Line 2 is the row's one voice about state, and in the 3a design it carries
 *  the whole statement — the boxed need pill and the amber square dot that used
 *  to share the job are both gone. So `waiting` is no longer the exception it
 *  was: an asking row sets its entire status line in ochre at 600 ("ready to
 *  merge · 68 commits", "waiting on your decision") and that is the only amber
 *  in the row. Nothing else here is coloured — working takes the live blue on
 *  the meta column's timer, and done/queued read down the neutral ink ramp.
 */
function statusInk(phase: MotionPhase): string | undefined {
  if (phase === 'waiting') return 'var(--attention)'
  if (phase === 'working') return 'var(--live)'
  if (phase === 'done') return 'var(--muted-foreground)'
  // --text-dim, not --text-faint: faint is 3.87:1 on the dark ground, and a
  // queued row's status word is persistent copy the reader is meant to be able
  // to read, not a hint. Dim clears AA (5.16:1) and still sits a step under the
  // done row's --muted-foreground (POD-783).
  if (phase === 'queued') return 'var(--text-dim)'
  return undefined
}

/**
 * The WORK-row skeleton, as redrawn by the 3a sidebar design (POD-1057):
 *
 *     [844]  Title of the mission                        ⠋ 4:53
 *            ◇◈ 5 of 8 tasks
 *            ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭
 *
 * THREE THINGS LEFT THIS ROW, and each of them was a second voice for something
 * the row already said:
 *
 *  1. THE ID SQUARE. A 30px tinted slab per row, whose click opened the colour
 *     picker. The number alone is the identity — the picker lives in the row's
 *     context menu, which is where every other property of an issue is set —
 *     and the colour it used to advertise is still on the row, as the band's
 *     own tint. Thirty rows of coloured chips was the loudest thing in a column
 *     whose job is to be scanned past.
 *  2. THE NEED PILL. `Needs you` in an amber box on line 1, beside a status
 *     line that in the same breath read `waiting on your decision`. One amber
 *     voice per region (DESIGN.md, The Signal Rule) — the words won.
 *  3. THE ROW RULE. A hairline under every row. With the section bands drawn as
 *     real bands (`work-folds`) the list no longer needs thirty separators to
 *     be legible, and losing them is most of what makes this column calm.
 *
 * What arrived: the lifecycle meta moved OFF line 2 and into a fixed right-hand
 * column on line 1, where it tabulates; and the progress meter came in-flow
 * under the text column as a full-width rule instead of hanging in the row's
 * bottom padding.
 *
 * Every title carries full ink, whatever the row's state — state is said in the
 * status line alone (see statusInk). The selected row is a BAND, not a card:
 * full column bleed, no radius, lifted to `--card` with a 3px ink spine on its
 * left edge. The spine is NEUTRAL now: the issue's hue is already the band's
 * ground, and selection is a different question from identity.
 */
export function WorkRowShell({
  idNumber,
  idLabel,
  label,
  statusLine,
  hex,
  phase,
  timeMeta,
  statusTime,
  meter,
  active,
  unread = false,
  onSelect,
  onContextMenu,
  onDoubleClick,
  editor,
  marks,
  titleHint,
  testId,
  deemphasized = false,
  domMark,
  statusExtra,
  gitStamp,
  onGripDown,
  onTuck,
  shortcutDigit,
}: {
  /** The identity gutter's digits — the part of the ref a human cites. */
  idNumber: string
  /** The FULL ref (`POD-844`), read in the digits' place by assistive tech. */
  idLabel: string
  label: string
  /** Line 2's status phrase (`rowStatusLine`) — the row's one state voice. */
  statusLine: ReactNode
  /** The issue colour hex, undefined for the neutral/slate flow. */
  hex: string | undefined
  phase: MotionPhase
  /** Line 1's right-hand meta column: the working clock or the waiting stamp. */
  timeMeta?: ReactNode
  /** Line 2's trailing time, for the phases whose stamp belongs beside the
   *  words rather than in the meta column (`done · 67:44 total`). */
  statusTime?: ReactNode
  /** The row's progress rule (`RowProgressMeter`), in flow under line 2. */
  meter?: ReactNode
  active: boolean
  /** Email-style unread emphasis: semibold title + info dot until opened. */
  unread?: boolean
  onSelect: () => void
  /** Right-click the row's select button (opens the issue context menu). */
  onContextMenu?: (e: ReactMouseEvent) => void
  /** Double-click the row's label (issue rename, #170). */
  onDoubleClick?: () => void
  /** When present, replaces the two-line block with an inline-rename input. */
  editor?: ReactNode
  /** Line-2 leading marks: the fleet glyphs, and any rare state word that has
   *  to ride with them. Line 1 is title + meta and nothing else (3a). */
  marks?: ReactNode
  /** Native hover tooltip on the row (issue ids, #21). */
  titleHint?: string
  testId: string
  /** Internal decomposition stays visible but subordinate to tracked work. */
  deemphasized?: boolean
  /** Issue id stamped as data-issue-row so lineage flashes can find the row. */
  domMark?: string
  /** Line 2's trailing slot after the timer (the spin-off ⤷ tick, POD-85). */
  statusExtra?: ReactNode
  /** Line 2's git stamp [POD-98]: dot + commit counters after the status phrase. */
  gitStamp?: ReactNode
  /** Manual-sort grip (POD-168): when set, a ⠿ handle fades in on the row's
   *  left edge on hover and pointerdown starts a drag. */
  onGripDown?: (e: ReactPointerEvent) => void
  /** Dismiss a finished row into the Closed fold (POD-293): when set, a quiet
   *  "tuck" chip takes over the meta column. Absent on live rows. */
  onTuck?: () => void
  /** ⌘-hold row shortcut (POD-790): while Command is down this row's digit is
   *  drawn over its number. Absent whenever Command is not held — and always,
   *  outside the macOS shell, where the chord is the browser's. */
  shortcutDigit?: number
}): JSX.Element {
  // One-shot transition morphs (§2.6): fire only on a REAL phase change under a
  // mounted row — →waiting flashes the row.
  const morph = usePhaseMorph(phase)
  const reduceMotion = useReducedMotion()
  const accent = hex ?? FLOW_CSS
  const phaseInk = statusInk(phase)
  const rowStyle: CSSProperties = active
    ? {
        // The band's spine. An inset shadow, not a border-left: selection must
        // not change the row's box on either axis (POD-81), and the spine has to
        // sit INSIDE the full-bleed band rather than push its content right.
        boxShadow: 'inset 3px 0 0 var(--text-strong)',
      }
    : hex
      ? // Var-driven so the hover class can override it — an inline `background`
        // would always beat `hover:` (POD-166: tint-aware hover). Both doses go
        // through --issue-tint-scale like every other tint in the shell, so warm
        // paper takes its lower dose and navy keeps the full one. The doses are
        // a step up from the pre-3a whisper (4/8) because the tint is now the
        // ONLY thing separating one row from the next — the hairline rules that
        // used to do that work are gone.
        ({
          '--row-bg': `color-mix(in srgb, ${hex} calc(7 * var(--issue-tint-scale, 1%)), var(--sidebar))`,
          '--row-hover-bg': `color-mix(in srgb, ${hex} calc(11 * var(--issue-tint-scale, 1%)), var(--sidebar))`,
        } as CSSProperties)
      : {}
  return (
    // The row is its own --issue scope: the band derives from it, and
    // data-issue-colored lets the no-colour flow take the quieter *-slate-*
    // doses (index.css) without a second set of inline mixes.
    <div
      className="issue-scope min-w-0"
      data-testid={testId}
      data-issue-colored={hex ? 'true' : 'false'}
      style={{ '--issue': accent } as CSSProperties}
    >
      <div
        className={cn(
          // FULL-BLEED, NOT A CARD, AND NOT RULED (3a). The row spans the whole
          // column; what separates it from its neighbour is the band tint and
          // the row's own breathing room, not a line. The list reads as one
          // surface with things ON it rather than as a stack of thirty slats.
          'shell-work-row phase-surface group/row relative flex min-h-[44px] min-w-0 items-center px-[13px]',
          // SELECTION IS A LIFT PLUS A SPINE. The band rises to the RAISED tier
          // and the ink spine names it as the one you are in. No issue wash on
          // top — the hue is the row's resting ground, and mixing more of it
          // into the selected row made selection read as "this one is greener".
          //
          // `--chip`, NOT `--card`, and the difference is whether selection is
          // visible at all in half the presets. The design draws this row as the
          // paper theme's white card, but two of the six theme blocks give
          // `--card` and `--sidebar` the SAME value (default dark and Podium
          // dark are both a flat near-black frame), so a card-toned band would
          // have been a selected row you cannot see. `--chip` is the shell's
          // "raised above the surface it sits on" tier by definition, and it is
          // a real step above `--sidebar` in every preset — including paper,
          // where it IS white and the design's own value.
          active && 'bg-chip',
          !active && !hex && 'hover:bg-muted',
          !active && hex && 'bg-[var(--row-bg)] hover:bg-[var(--row-hover-bg)]',
          // STATE IS SAID IN THE STATUS LINE, NOT BY FADING THE ROW (POD-725).
          morph === 'waiting' && 'morph-row-flash',
          // Subordinate, by ink alone.
          deemphasized && !active && 'opacity-70',
        )}
        style={rowStyle}
        data-phase={phase}
        data-selected={active ? 'true' : 'false'}
        {...(domMark ? { 'data-issue-row': domMark } : {})}
      >
        {onGripDown && (
          // Manual-sort grip (POD-168, §4): 10px zone on the row's left edge,
          // visible only on hover — order is the user's, nothing else moves it.
          <span
            className="shell-type-micro absolute inset-y-0 left-0.5 z-[1] flex w-2.5 cursor-grab select-none items-center justify-center text-transparent transition-colors duration-150 group-hover/row:text-muted-foreground/70"
            style={{ touchAction: 'none' }}
            data-testid="row-grip"
            aria-hidden="true"
            onPointerDown={onGripDown}
          >
            ⠿
          </span>
        )}
        {editor ? (
          // Inline rename (#170): the input replaces the two-line block in
          // place, and the gutter stays put so the row does not jump.
          <div className="flex min-w-0 flex-1 items-center gap-[11px]">
            <IdGutter number={idNumber} label={idLabel} shortcutDigit={shortcutDigit} />
            <div className="flex min-w-0 flex-1 items-center">{editor}</div>
          </div>
        ) : (
          <button
            data-pressable
            type="button"
            // leading-[normal]: the two-line block runs the font's natural line
            // height — the preflight 1.5 would inflate every row (#64).
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-[11px] text-left leading-[normal]"
            title={titleHint}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <IdGutter number={idNumber} label={idLabel} shortcutDigit={shortcutDigit} />
            {/* gap-[5px]: the design's leading between title, status and rule.
                All three lines are set on their own tight leading so the row
                lands on the 44px (2-line) / 52px (with a meter) rhythm. */}
            <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'shell-work-row-title min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
                    // The title is NEUTRAL INK: the colour lives on the band,
                    // and the title's job is to be the most readable thing in
                    // the row. Unread alone lifts to semibold and takes the info
                    // dot.
                    unreadTitleClass(unread, active),
                    // The selected row's title goes MEDIUM (3a). It is the one
                    // weight step selection is allowed: the band's lift and the
                    // ink spine already say which row you are in, and a bolder
                    // title on top of both made the selection shout in a column
                    // whose whole point is that nothing shouts.
                    active && !unread && 'font-medium',
                  )}
                >
                  {label}
                </span>
                {unread ? (
                  <>
                    <UnreadDot />
                    <span className="sr-only">unread</span>
                  </>
                ) : (
                  <UnreadDot reserve />
                )}
                {/* The meta column. Reserved whether or not it has anything in
                    it, and reserved at the same width on every row — a title
                    that ellipsized at a different x per row is the one thing a
                    scannable list cannot afford. The tuck chip parks here too,
                    drawn over the top as its own button. */}
                <span
                  className="shell-type-micro mono-timer flex flex-none justify-end text-right text-muted-foreground"
                  style={{ minWidth: META_COL_W }}
                  data-testid="row-meta-column"
                >
                  {onTuck ? null : timeMeta}
                </span>
              </span>
              {/* Line 2 is set in mono: the machine voice tabulates the status
                  word, the counters and the git stamp onto one even baseline.
                  The phrase takes the slack (flex-1, truncating) so the right-
                  hand facts — the git stamp, the spin-off tick — hold the row's
                  right edge instead of being pushed off it. */}
              <span
                className="shell-work-row-status flex min-w-0 items-center gap-1.5 font-mono text-muted-foreground"
                data-testid="row-lifecycle-status"
                data-phase={phase}
                // The asking row's whole line goes ochre at 600 — it is the
                // row's single amber voice now that the pill is gone.
                style={phaseInk ? { color: phaseInk } : undefined}
              >
                {marks}
                <span
                  className={cn(
                    'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
                    phase === 'waiting' ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {statusLine}
                  {statusTime}
                </span>
                {gitStamp}
                {statusExtra}
              </span>
              {meter}
            </span>
          </button>
        )}
        {/* Tuck-away (POD-293): a finished task no longer vanishes into Closed
            on its own the moment it's read — it holds its place with this
            explicit control. In 3a it takes over line 1's meta column (a done
            row has no clock to show there), drawn over the button rather than
            inside it because a button cannot nest. Chip navy over a seam
            hairline, machine voice, no amber: nothing is being asked here. On
            hover it firms and the glyph nudges DOWN — a small, honest cue that
            pressing it folds the row into Closed, where it stays reachable. */}
        {onTuck && (
          <motion.button
            data-pressable
            type="button"
            data-testid="tuck-away"
            initial={reduceMotion ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }
            }
            // A 20px rim-only pill sitting in the meta column's box. The rim is
            // an inset shadow, not a border, so the 20px is 20px of readable
            // inside — and the chip can never add a pixel to the row it rides.
            className="shell-type-micro group/tuck absolute right-[13px] flex h-5 items-center gap-1 rounded-[6px] px-[7px] font-mono leading-none tracking-[0.02em] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] transition-colors hover:bg-accent hover:text-text-strong"
            // Pinned to line 1's box: the row's own top padding, minus the 2px
            // the 20px chip is taller than the 16px line it sits on.
            style={{ top: 'calc(var(--work-row-pad) - 2px)' }}
            title="Tuck this finished task down into Closed — it stays reachable there (click to reopen, or start an agent to pick it back up). Nothing is killed or closed."
            aria-label={`Tuck ${label} into Closed`}
            onClick={(event) => {
              event.stopPropagation()
              onTuck()
            }}
          >
            <ArrowDownToLine
              size={11}
              aria-hidden="true"
              className="text-text-faint transition-[transform,color] duration-150 group-hover/tuck:translate-y-px group-hover/tuck:text-muted-foreground"
            />
            <span>Tuck</span>
          </motion.button>
        )}
      </div>
    </div>
  )
}

/** The identity gutter. Text, not a control (3a): the colour picker it used to
 *  open lives in the row's context menu, and the number is left to be the one
 *  thing it always was — the part of the ref you cite. `relative` so the ⌘-hold
 *  digit can cover it exactly without moving anything.
 *
 *  The DIGITS are hidden from assistive tech and the full ref read in their
 *  place: sighted readers have the project's name in the band a few rows up, so
 *  `844` is unambiguous on screen, while a screen reader arriving at one row out
 *  of thirty gets `POD-844` — the thing you would actually say out loud. */
function IdGutter({
  number,
  label,
  shortcutDigit,
}: {
  number: string
  label: string
  shortcutDigit?: number
}): JSX.Element {
  return (
    <span
      className="shell-work-row-status relative flex flex-none justify-end font-mono tabular-nums text-muted-foreground"
      style={{ width: ID_GUTTER_W }}
      data-testid="row-id-number"
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">{number}</span>
      {shortcutDigit !== undefined && <RowShortcutBadge digit={shortcutDigit} size={24} />}
    </span>
  )
}
