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
import { FLOW_CSS } from '@/lib/issueColors'
import { usePhaseMorph } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** The status word's own state colour (POD-725 §3). Only the lockup is tinted —
 *  the rest of line 2 stays `--muted-foreground`, so the row says its state in
 *  one word rather than colouring a whole sentence.
 *
 *  Waiting is deliberately absent. The design gives a waiting phase word
 *  `--attention`, but this row already spends its one amber voice on the ask
 *  itself — the decision word ("needs review", "ready to merge"), the need pill,
 *  or the square's corner dot (POD-293, The Signal Rule). A second ochre word
 *  beside them would say "needs you" twice in one region. */
function statusInk(phase: MotionPhase): string | undefined {
  if (phase === 'working') return 'var(--live)'
  if (phase === 'done') return 'var(--muted-foreground)'
  if (phase === 'queued') return 'var(--text-faint)'
  return undefined
}

/**
 * The WORK-row skeleton (§2.4/§2.5, and the approved artifact's `work-row`):
 * [ID square][title + need pill / status line + motion meta][fleet][bridge notch].
 *
 * ONE ROW, NO DETAIL BLOCK (POD-516 §1.1). The shell used to own a disclosure
 * chevron, an agent roster band and a `.tree-children` well that recursed into
 * child issues — the competing navigation tree the design doctrine forbids in
 * this column. It is a leaf now: everything a mission's subtree has to say is
 * summarised on the single line, and the tree itself lives in the Flight Deck.
 *
 * Queued rows dim whole (.65). The selected row is a BAND, not a card
 * (POD-725): full column bleed, no radius, lifted to the card tone with a
 * whisper of the issue over it, a 3px `--issue` spine on its left edge — which
 * continues across the top of the flight deck beside it — and the notch that
 * crosses the aside border toward the engraved column.
 */
export function WorkRowShell({
  square,
  label,
  statusLine,
  hex,
  phase,
  waitingCount,
  showWaitingPill = true,
  timeMeta,
  meter,
  active,
  unread = false,
  onSelect,
  onContextMenu,
  onDoubleClick,
  editor,
  extras,
  titleHint,
  testId,
  deemphasized = false,
  domMark,
  statusExtra,
  gitStamp,
  onGripDown,
  onTuck,
}: {
  /** The leading 26px identity square (owns its own click). */
  square: ReactNode
  label: string
  /** Line 2's status phrase (`rowStatusLine`), grouped with phase icon + timer. */
  statusLine: ReactNode
  /** The issue colour hex, undefined for the neutral/slate flow. */
  hex: string | undefined
  phase: MotionPhase
  /** Line-1 need-pill count (0 = no pill). */
  waitingCount: number
  /** Render the need pill (POD-293). False on rows that already carry an amber
   *  decision word, so "needs you" isn't said twice in the same region. */
  showWaitingPill?: boolean
  /** Line 2's lifecycle meta (the PhaseTimer). */
  timeMeta?: ReactNode
  /** The row's baseline progress rule (POD-516 round 3, `RowProgressMeter`).
   *  Drawn INSIDE the row's bottom padding and absolutely positioned, so a row
   *  that carries one is exactly as tall as a row that does not — see
   *  row-progress.tsx for why the meter is a rule under the text column rather
   *  than a chip on either line. Absent on rows with no real subtree. */
  meter?: ReactNode
  active: boolean
  /** Email-style unread emphasis (#126): the label reads bold until opened. */
  unread?: boolean
  onSelect: () => void
  /** Right-click the row's select button (opens the issue context menu). */
  onContextMenu?: (e: ReactMouseEvent) => void
  /** Double-click the row's label (issue rename, #170). */
  onDoubleClick?: () => void
  /** When present, replaces the two-line block with an inline-rename input. */
  editor?: ReactNode
  /** Line-1 chips after the title (fleet stack / pin / snooze). */
  extras?: ReactNode
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
   *  "tuck away" control rides the row's right edge. Absent on live rows. */
  onTuck?: () => void
}): JSX.Element {
  // One-shot transition morphs (§2.6): fire only on a REAL phase change under a
  // mounted row — queued→working ignites the square, →waiting flashes the row.
  const morph = usePhaseMorph(phase)
  const reduceMotion = useReducedMotion()
  const accent = hex ?? FLOW_CSS
  const phaseInk = statusInk(phase)
  const rowStyle: CSSProperties = active
    ? {
        // The band's spine. An inset shadow, not a border-left: selection must
        // not change the row's box on either axis (POD-81), and the spine has to
        // sit INSIDE the full-bleed band rather than push its content right.
        boxShadow: 'inset 3px 0 0 var(--issue)',
      }
    : hex
      ? // Var-driven so the hover class can override it — an inline `background`
        // would always beat `hover:` (POD-166: tint-aware hover). Both doses go
        // through --issue-tint-scale like every other tint in the shell, so warm
        // paper takes its lower dose and navy keeps the full one; the numbers are
        // a whisper because an unselected row must never out-read the band below.
        ({
          '--row-bg': `color-mix(in srgb, ${hex} calc(4 * var(--issue-tint-scale, 1%)), var(--sidebar))`,
          '--row-hover-bg': `color-mix(in srgb, ${hex} calc(8 * var(--issue-tint-scale, 1%)), var(--sidebar))`,
        } as CSSProperties)
      : {}
  return (
    // The row is its own --issue scope: the band, the spine and the bridge notch
    // all derive from it, and data-issue-colored lets the no-colour flow take the
    // quieter *-slate-* doses (index.css) without a second set of inline mixes.
    <div
      className="issue-scope min-w-0"
      data-testid={testId}
      data-issue-colored={hex ? 'true' : 'false'}
      style={{ '--issue': accent } as CSSProperties}
    >
      <div
        className={cn(
          // FULL-BLEED, NOT A CARD (POD-725). The row spans the whole column and
          // is separated from the next by a hairline rule rather than a gap and a
          // radius — a list of thirty rounded tiles reads as thirty objects, and
          // the paper design wants one continuous list with one lifted band in it.
          'shell-work-row phase-surface group/row relative flex min-w-0 items-center gap-2.5 border-b px-3.5',
          // SELECTION IS A LIFT PLUS A SPINE, NOT A WASH: the band brightens to
          // the card tone and carries only a whisper of the issue over it, so the
          // colour names the row without being the thing that makes it visible.
          // The rule is transparent rather than absent so the box never changes
          // height — the band's own ground paints through it (border-box clip).
          active
            ? 'issue-base-card issue-mix-10 issue-mix-slate-8 border-transparent'
            : 'border-hairline-soft',
          !active && !hex && 'hover:bg-muted',
          !active && hex && 'bg-[var(--row-bg)] hover:bg-[var(--row-hover-bg)]',
          phase === 'queued' && !active && 'opacity-65',
          // A finished row that still carries the tuck-away control stays at full
          // strength (POD-293) so the control reads crisp — the grey "done" status
          // already says it's finished; the dim only returns once it can't be
          // dismissed here (e.g. an unread completion).
          phase === 'done' && !active && !unread && !onTuck && 'opacity-70',
          morph === 'waiting' && 'morph-row-flash',
          // Subordinate, by ink alone. The 2% scale-down that used to go with it
          // is gone: on a full-bleed band it opened a sliver of column at both
          // edges, which read as a broken row rather than a quieter one.
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
        <span className={cn('flex flex-none', morph === 'working' && 'morph-ignite')}>
          {square}
        </span>
        {editor ? (
          // Inline rename (#170): the input replaces the two-line block in place.
          <div className="flex min-w-0 flex-1 items-center">{editor}</div>
        ) : (
          <button
            data-pressable
            type="button"
            // leading-[normal]: the handoff rows run the font's natural line
            // height — the preflight 1.5 would grow the two-line block past
            // the 26px square and inflate every row (#64).
            // `relative`: the progress rule hangs off this column's own box, so
            // it starts under the title (never at the row's edge, where it
            // would read as a divider) and ends where the text column ends.
            // gap-[3px]: the design's title→status leading. The two lines also
            // dropped a type step each (line 2 is the micro role now), so the
            // text column ends up exactly as tall as it was — a row does not
            // change height because its status line got quieter.
            className="relative flex min-w-0 flex-1 cursor-pointer flex-col gap-[3px] text-left leading-[normal]"
            title={titleHint}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'shell-type-primary min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
                  // The title is NEUTRAL INK now (POD-725). It used to be mixed
                  // with the issue colour, which put a second, weaker statement of
                  // the row's hue on top of the square that already says it — and
                  // on warm paper a 25% tint into the body ink just read as faded
                  // text. The colour lives on the square, the spine and the band;
                  // the title's job is to be the most readable thing in the row.
                  // Selection lifts to semibold + strong ink per the design;
                  // UNREAD keeps its email-style medium independent of it (#126).
                  active ? 'font-semibold text-text-strong' : 'text-foreground',
                  !active && unread && 'font-medium',
                )}
              >
                {label}
              </span>
              {/* Unread no longer shouts a banner (POD-293): the bold title
                  above and the info dot on the fleet glyph (in `extras`) carry
                  it, so the row keeps one attention voice. Prior art on why a
                  free-floating blue dot was rejected: POD-236 — this dot is
                  bound to the agent identity, not a third positional meaning. */}
              {extras}
              {/* THE NEED PILL (the artifact's `need-pill`). It reads in words —
                  "Needs you" for one, "N need you" for a branch — because a bare
                  amber digit beside a stack of agent tiles was read as another
                  head-count. Words cannot be. It earns its place only on a row
                  that ISN'T already saying "needs you" in a decision word
                  (POD-293), and its count is the whole subtree's, so the ask
                  survives having no rows below it here. */}
              {showWaitingPill && waitingCount > 0 && (
                <span
                  key={`pill:${waitingCount}`}
                  className={cn(
                    'shell-type-micro flex-none rounded-[8px] border border-attention/35 bg-attention/10 px-[5px] font-mono font-semibold whitespace-nowrap text-attention',
                    morph !== null && 'morph-pop',
                  )}
                  data-testid="need-pill"
                  role="img"
                  aria-label={`${waitingCount} waiting on you`}
                >
                  {waitingCount === 1 ? 'Needs you' : `${waitingCount} need you`}
                </span>
              )}
            </span>
            {/* Line 2 is set in mono (POD-293): the machine voice tabulates the
                status word, timer and git counters onto one even baseline —
                baseline-aligned so the right-side facts ("22 uncommitted", the
                spin-off tick) sit level with the status word, not lifted toward
                the agent tiles on the line above. */}
            <span className="shell-type-micro flex min-w-0 items-baseline gap-1.5 font-mono text-muted-foreground">
              {/* One lifecycle lockup is the row's first-glance answer. Agent
                  tiles remain identity-only; git renders only exceptions. */}
              <span
                className="flex min-w-0 flex-1 items-center gap-1.5"
                data-testid="row-lifecycle-status"
                data-phase={phase}
                // Yellow is the one signal (POD-293): a waiting row is NOT tinted
                // amber wholesale — the ask (decision word / need pill / square
                // dot) carries it, and the status/time read dim. See statusInk.
                style={phaseInk ? { color: phaseInk } : undefined}
              >
                {/* The working spinner rides the ID square's corner badge now
                    (POD-293), and a done row needs no ✓ beside its "done · Ns" —
                    so line 2 stays a clean one-voice status phrase. */}
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                  {statusLine}
                </span>
                {timeMeta}
              </span>
              {gitStamp}
              {statusExtra}
            </span>
            {meter}
          </button>
        )}
        {/* Tuck-away (POD-293): a finished task no longer vanishes into Closed on
            its own the moment it's read — it holds its place with this explicit
            control, styled in the sidebar's own raised-chip vocabulary (chip
            navy over a seam hairline, machine voice). No amber: nothing is being
            asked here. On hover it firms and the glyph nudges DOWN — a small,
            honest cue that pressing it folds the row down into Closed, where it
            stays reachable (click to reopen, or start an agent to pick it up).
            It kills nothing and closes nothing — the task is already finished.
            Arrival is a one-shot fade-slide from the right (same ease as row
            arrivals) so the control reads as a new right-edge action, not a
            hard pop. */}
        {onTuck && (
          <motion.button
            data-pressable
            type="button"
            data-testid="tuck-away"
            initial={reduceMotion ? false : { opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }
            }
            // The design's action chip (POD-725): a 20px rim-only pill on line 1
            // rather than the full-height slab it used to be. The rim is an inset
            // shadow, not a border, so the 20px is 20px of readable inside — and
            // the chip can never add a pixel to the row it rides on.
            className="group/tuck flex h-5 flex-none items-center gap-1.5 self-center rounded-[6px] px-[7px] font-mono text-[9.5px] leading-none tracking-[0.02em] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] transition-colors hover:bg-accent hover:text-text-strong"
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
            <span>Tuck away</span>
          </motion.button>
        )}
        {/* Bridge notch (§2.5): grows from the selected row's right edge over the
            aside border toward the engraved column, tinted by the issue colour. */}
        {active && (
          <span
            data-testid="bridge-notch"
            aria-hidden="true"
            // Var-driven gradient over the row's own --issue scope: a fresh
            // colour pick animates the notch through the registered --issue
            // transition — gradient images themselves can't interpolate.
            className="pointer-events-none absolute top-[9px] right-[-10px] bottom-[9px] w-[10px] rounded-r-[3px]"
            style={{
              background: `linear-gradient(90deg, color-mix(in srgb, var(--issue) ${hex ? 85 : 75}%, transparent), color-mix(in srgb, var(--issue) ${hex ? 12 : 10}%, transparent))`,
            }}
          />
        )}
      </div>
    </div>
  )
}
