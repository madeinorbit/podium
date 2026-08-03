import { ArrowDownToLine, ChevronDown, ChevronRight } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type {
  CSSProperties,
  JSX,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react'
import type { MotionPhase } from '@/lib/derive'
import { FLOW_SLATE } from '@/lib/issueColors'
import { usePhaseMorph } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** Line-1/line-2 text tints for one row (§2.4): everything colour-flows from
 *  the issue colour; uncoloured rows read the neutral greys (slate when
 *  selected — the no-colour flow accent, never a pickable colour). */
function rowTints(hex: string | undefined, phase: MotionPhase, active: boolean) {
  return {
    title: active
      ? hex
        ? `color-mix(in srgb, ${hex} 10%, #f7f7fc)`
        : '#f2f5fa'
      : hex
        ? `color-mix(in srgb, ${hex} 25%, #d7d7e0)`
        : phase === 'queued'
          ? '#9a9aa8'
          : '#d7d7e0',
    status: hex ? `color-mix(in srgb, ${hex} 55%, #9a9aa8)` : active ? '#aab6c8' : '#6c6c78',
  }
}

/**
 * The shared two-line WORK-row skeleton (§2.4/§2.5):
 * [ID square][title + amber pill / status line + motion meta][bridge notch].
 * Issue and worktree rows both render through it — they differ only in the
 * leading square and their extras. Queued rows dim whole (.65); the selected
 * row wears the colour-mixed background, border and the notch that crosses the
 * aside border toward the engraved column.
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
  active,
  unread = false,
  expandable,
  collapsed,
  onToggle,
  onSelect,
  onContextMenu,
  onDoubleClick,
  editor,
  extras,
  titleHint,
  children,
  testId,
  deemphasized = false,
  domMark,
  statusExtra,
  gitStamp,
  onGripDown,
  onTuck,
  band,
  hasTreeChildren,
  childDragScope,
  childrenTestId,
}: {
  /** The leading 26px identity square (owns its own click). */
  square: ReactNode
  label: string
  /** Line 2's status phrase (`rowStatusLine`), grouped with phase icon + timer. */
  statusLine: ReactNode
  /** The issue colour hex, undefined for the neutral/slate flow. */
  hex: string | undefined
  phase: MotionPhase
  /** Amber line-1 pill count (0 = no pill). */
  waitingCount: number
  /** Render the amber count pill (POD-293). False on rows that already carry an
   *  amber decision word, so "needs you" isn't said twice in the same region. */
  showWaitingPill?: boolean
  /** Line 2's lifecycle meta (the PhaseTimer). */
  timeMeta?: ReactNode
  active: boolean
  /** Email-style unread emphasis (#126): the label reads bold until opened. */
  unread?: boolean
  expandable: boolean
  collapsed: boolean
  onToggle: () => void
  onSelect: () => void
  /** Right-click the row's select button (opens the issue context menu). */
  onContextMenu?: (e: ReactMouseEvent) => void
  /** Double-click the row's label (issue rename, #170). */
  onDoubleClick?: () => void
  /** When present, replaces the two-line block with an inline-rename input. */
  editor?: ReactNode
  /** Line-1 chips after the title (pin / snooze / epic). */
  extras?: ReactNode
  /** Native hover tooltip on the row (issue ids, #21). */
  titleHint?: string
  children?: ReactNode
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
  /** Agent roster band (POD-170, L2): rendered adjacent to the row, outside
   * the subtask tree, and folded with the row's other secondary detail. */
  band?: ReactNode
  /** True when the detail block contains issue-tree/roll-up content. */
  hasTreeChildren: boolean
  /** Drag scope and test marker belong on the actual tree container so each
   * child can be a direct descendant and receive a correctly aligned stub. */
  childDragScope?: string
  childrenTestId?: string
}): JSX.Element {
  // One-shot transition morphs (§2.6): fire only on a REAL phase change under a
  // mounted row — queued→working ignites the square, →waiting flashes the row.
  const morph = usePhaseMorph(phase)
  const reduceMotion = useReducedMotion()
  const accent = hex ?? FLOW_SLATE
  const tints = rowTints(hex, phase, active)
  const rowStyle: CSSProperties = active
    ? {
        background: `color-mix(in srgb, ${accent} ${hex ? 28 : 20}%, #16161c)`,
        // Inset ring, not a border: selection must not change the row's height
        // (POD-81) — the box stays identical to a plain row's.
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} ${hex ? 80 : 70}%, transparent)`,
      }
    : hex
      ? // Var-driven so the hover class can override it — an inline `background`
        // would always beat `hover:` (POD-166: tint-aware hover, +5% mix).
        ({
          '--row-bg': `color-mix(in srgb, ${hex} 12%, #16161c)`,
          '--row-hover-bg': `color-mix(in srgb, ${hex} 17%, #16161c)`,
        } as CSSProperties)
      : {}
  // A coloured issue's expanded block reads as ONE carved card (POD-293): the row
  // and its agent/subtask detail share a continuous tint inside a single
  // issue-toned hairline (The Tint, Never Fill Rule), instead of the tint
  // stopping at the row edge and the agents sitting bare on the chassis.
  const hasDetail = hasTreeChildren || (!collapsed && Boolean(band))
  const carded = Boolean(hex) && hasDetail
  return (
    <div
      className={cn('min-w-0', carded && 'rounded-[8px] border')}
      style={
        carded
          ? {
              // Subtle by design (POD-293): the issue-toned hairline is what
              // unifies the card; the fill is only a whisper so the row stays the
              // one strongly-coloured surface and the detail reads recessed.
              borderColor: `color-mix(in srgb, ${hex} 34%, transparent)`,
              background: `color-mix(in srgb, ${hex} 5%, #14141a)`,
            }
          : undefined
      }
      data-testid={testId}
    >
      <div
        className={cn(
          'phase-surface group/row relative flex min-w-0 items-center gap-2 rounded-[7px] py-[6.5px] pr-2 pl-3.5',
          carded && 'rounded-b-none',
          !active && !hex && 'hover:bg-[#20202a]',
          !active && hex && 'bg-[var(--row-bg)] hover:bg-[var(--row-hover-bg)]',
          phase === 'queued' && !active && 'opacity-65',
          // A finished row that still carries the tuck-away control stays at full
          // strength (POD-293) so the control reads crisp — the grey "done" status
          // already says it's finished; the dim only returns once it can't be
          // dismissed here (e.g. an unread completion).
          phase === 'done' && !active && !unread && !onTuck && 'opacity-70',
          morph === 'waiting' && 'morph-row-flash',
          deemphasized && !active && 'scale-[0.98] opacity-70',
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
            className="absolute inset-y-0 left-0.5 z-[1] flex w-2.5 cursor-grab select-none items-center justify-center text-[9px] leading-none text-transparent transition-colors duration-150 group-hover/row:text-muted-foreground/70"
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
        {expandable && (
          <button
            data-pressable
            type="button"
            className="-ml-1.5 flex w-3.5 flex-none cursor-pointer items-center justify-center self-stretch text-muted-foreground/60 hover:text-foreground"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          >
            {collapsed ? (
              <ChevronRight size={11} aria-hidden="true" />
            ) : (
              <ChevronDown size={11} aria-hidden="true" />
            )}
          </button>
        )}
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
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-px text-left leading-[normal]"
            title={titleHint}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px]',
                  // Selection lifts to semibold per the handoff; UNREAD keeps its
                  // email-style medium independent of selection (#126).
                  active ? 'font-semibold' : unread && 'font-medium',
                )}
                style={{ color: tints.title }}
              >
                {label}
              </span>
              {/* Unread no longer shouts a banner (POD-293): the bold title
                  above and the info dot on the fleet glyph (in `extras`) carry
                  it, so the row keeps one attention voice. Prior art on why a
                  free-floating blue dot was rejected: POD-236 — this dot is
                  bound to the agent identity, not a third positional meaning. */}
              {extras}
              {/* The amber count earns its pill only on a row that ISN'T already
                  saying "needs you" in words (POD-293): a review / merge decision
                  carries the amber voice itself and the fleet tiles already show
                  how many agents are here, so a second amber number beside them
                  was the same signal three times. On a wordless waiting row (an
                  agent's question) the pill stays — there it IS the needs-you
                  signal, and its count survives the row being collapsed. */}
              {showWaitingPill && waitingCount > 0 && (
                <span
                  key={`pill:${waitingCount}`}
                  className={cn(
                    'flex-none rounded-full bg-attention px-[5px] text-[9px] font-bold text-attention-foreground',
                    morph !== null && 'morph-pop',
                  )}
                  role="img"
                  aria-label={`${waitingCount} waiting on you`}
                >
                  {waitingCount}
                </span>
              )}
            </span>
            {/* Line 2 is set in mono (POD-293): the machine voice tabulates the
                status word, timer and git counters onto one even baseline —
                baseline-aligned so the right-side facts ("22 uncommitted", the
                spin-off tick) sit level with the status word, not lifted toward
                the agent tiles on the line above. */}
            <span
              className="flex min-w-0 items-baseline gap-1.5 font-mono text-[9.5px]"
              style={{ color: tints.status }}
            >
              {/* One lifecycle lockup is the row's first-glance answer. Agent
                  tiles remain identity-only; git renders only exceptions. */}
              <span
                className="flex min-w-0 flex-1 items-center gap-1.5"
                data-testid="row-lifecycle-status"
                data-phase={phase}
                style={
                  // Yellow is the one signal (POD-293): a waiting row is NOT
                  // tinted amber wholesale — the ask (decision word / count pill /
                  // square dot) carries it, and the status/time read dim. Only
                  // working (blue) and done (grey) tint their lockup.
                  phase === 'working'
                    ? { color: 'var(--motion-working)' }
                    : phase === 'done'
                      ? { color: 'var(--motion-total)' }
                      : undefined
                }
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
            // Full content-height (POD-293): the control stretches to align with
            // the top of the square and the bottom of the status line, reading as
            // one clean right-edge action rather than a small floating chip.
            className="group/tuck flex flex-none items-center gap-1.5 self-stretch rounded-md border border-[#243356] bg-[#16223c] px-2 font-mono text-[9px] tracking-[0.02em] text-[#7a84a0] transition-colors hover:border-[#364a78] hover:bg-[#1b2b49] hover:text-[#e6e9f2]"
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
              className="text-[#525c78] transition-[transform,color] duration-150 group-hover/tuck:translate-y-px group-hover/tuck:text-[#9aa4c0]"
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
            // issue-scope + var-driven gradient: a fresh colour pick animates
            // the notch through the registered --issue transition — gradient
            // images themselves can't interpolate.
            className="issue-scope pointer-events-none absolute top-[9px] right-[-10px] bottom-[9px] w-[10px] rounded-r-[3px]"
            style={
              {
                '--issue': accent,
                background: `linear-gradient(90deg, color-mix(in srgb, var(--issue) ${hex ? 85 : 75}%, transparent), color-mix(in srgb, var(--issue) ${hex ? 12 : 10}%, transparent))`,
              } as CSSProperties
            }
          />
        )}
      </div>
      {/* Agent roster band (L2): adjacent to the row, one tone tier below the
          panel, NEVER inside the subtask tree or behind the chevron. */}
      {/* Subtask rows (L1 — the chevron's one promise): a tree guide (vertical
          line + per-row stubs, via .tree-children CSS) ties the child ISSUES to
          their parent; sessions render in the band above. A coloured issue
          flows its tint into the unfolded block: a quiet wash behind the
          children, a tinted guide, and colour-mixed active/hover on the child
          rows — all via vars with neutral fallbacks so uncoloured rows (and
          every other PanelRow context) are untouched. */}
      {/* Subtasks are rows, agents are a count (POD-293): the child ISSUE tree
          stays visible — it's real tracked work you can select — while only the
          agent ROSTER band folds behind the chevron. So `collapsed` gates the
          band alone; `hasTreeChildren` renders regardless. */}
      {hasDetail && (
        <div
          className={cn(
            'tree-children relative pt-0.5 pb-1',
            carded ? 'rounded-b-[8px]' : 'rounded-b-[7px]',
          )}
          data-drag-scope={hasTreeChildren ? childDragScope : undefined}
          data-testid={hasTreeChildren ? childrenTestId : undefined}
          style={
            hex
              ? ({
                  '--tree-guide': `color-mix(in srgb, ${hex} 55%, var(--border))`,
                  '--child-active-bg': `color-mix(in srgb, ${hex} 26%, #16161c)`,
                  '--child-hover-bg': `color-mix(in srgb, ${hex} 18%, #16161c)`,
                  // Recessed and subtle (POD-293): the detail sits on a darker
                  // navy than the row with only a whisper of the issue hue, so the
                  // card reads carved-in — the coloured row above, a quiet well
                  // below — rather than one uniform slab of tint.
                  background: `color-mix(in srgb, ${hex} 6%, #0e1422)`,
                } as CSSProperties)
              : undefined
          }
        >
          {hasTreeChildren && (
            <span
              className="tree-guide absolute top-0 bottom-3 left-4 w-px bg-[var(--tree-guide,var(--border))]"
              aria-hidden="true"
            />
          )}
          {!collapsed && band && <div data-tree-band>{band}</div>}
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * One issue row in the work list. Agent drafts (draft issue whose only content
 * is agents, no worktree) click straight into their session. Real issues show
 * the ID square and expand (default expanded) to their member sessions from 2
 * agents up.
 */
