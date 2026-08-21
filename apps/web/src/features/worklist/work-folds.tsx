import { relativeTime } from '@podium/client-core/focus'
import {
  issueClosedFoldAt,
  type IssueNavigationModel,
  type UnifiedIssueRow as UnifiedIssueRowView,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import { canonicalIssueCloseReason, ISSUE_STATUS_LABELS } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { Archive, ChevronRight, Pin } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import { type RowTransitionItem, useArrivals } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { closedFoldKey, snoozedFoldKey } from './fold-keys'
import { useCollapsed } from './sidebar-common'
import { ID_GUTTER_W } from './WorkRowShell'

/** The two TAIL folds — suspended work, settled closures — in the 3a voice: a
 *  count, a rule, the chevron holding its right end. `12 closed`, not
 *  `Closed · 12`: the quantity is what you are deciding about, and leading with
 *  the label made these look like the SECTION BANDS, which own a name. */
/*  The artboard's box is `padding:16px 13px 0` — sixteen of air above the line
 *  and NOTHING under it, so the fold sits directly on the rows it opens onto.
 *  Ours carried a 4px tail, which read as a gap the fold did not own, and the
 *  count sat a rung too faint to be the thing you are deciding about. */
const TAIL_FOLD_CLASS =
  'flex w-full items-center gap-[9px] px-[13px] pt-4 text-left font-mono text-[10px] tracking-[.02em] tabular-nums text-text-dim hover:text-muted-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px]'

/**
 * THE SECTION BAND (POD-1057, the 3a design).
 *
 * It was a label floating on the column's ground — fine while every row under it
 * drew a hairline, but with the rules gone (see `WorkRowShell`) the labels were
 * the only structure left in a 30-row column and the lightest marks in it. So it
 * became a BAND: 34px of ground under a hairline, full-bleed, `--muted`. It had a
 * rule on both edges while it was the only ruled thing in the column; with the
 * rows ruled again (POD-1078) the top one was drawing a second line a pixel
 * under the last row's, so the band keeps the edge that is its own.
 *
 * AND IT IS A CONTROL: every band shuts, taking the group's rows and its
 * snoozed/closed tails, so four repos fold to four lines. State persists per
 * user (`fold-keys.ts`). The chevron is revealed, not resident — but a COLLAPSED
 * band keeps it, since a shut band that looked like an empty open one is a trap.
 */
/** The band's own geometry and ground, without the affordances of a control.
 *  Shared because the empty work list wears a band too (POD-1058) and there is
 *  nothing there to fold: a STATIC band, so it takes the shape and the tone but
 *  none of the hover, focus or transition a button needs. Two spellings of
 *  35px/`--muted`/hairline would drift the moment one of them is retuned.
 *
 *  35px, NOT 34 (POD-1253): the mock's `height:34px` is a CONTENT box — the file
 *  sets `box-sizing:border-box` exactly once, on its outer <section>, so the
 *  1px rule sits OUTSIDE the 34 and the band measures 35. Ours spent the rule
 *  inside the 34 and gave the band 33px of ground. Same reading error as the
 *  row's `min-height`, one pixel instead of four. */
export const SECTION_BAND_CLASS =
  'flex h-[35px] w-full flex-none items-center gap-[9px] border-b border-hairline-bar bg-muted px-[13px] text-left'

/** The gap ABOVE a section that is not the first (POD-1078, the design's 14px).
 *  The band already said where a group STARTS; nothing said where one ended, so
 *  a project's last row and the next project's band met on a single hairline and
 *  the two groups read as one run. 14px of the column's ground parts them, and
 *  it stays well under the band's 35px so the band is still the thing you see
 *  when you scan.
 *
 *  It sits on the section, not between sections (no `gap` on the scroller): the
 *  pinned block and every project group are independently mounted and animated,
 *  and a parent gap would apply to a section that a filter had just emptied. The
 *  FIRST rendered section takes no gap — the list opens flush under the search
 *  field, the way it opens flush under the header in the design. */
export const SECTION_GAP_CLASS = 'mt-[14px]'

/** The band's label voice — mono, tracked, `--muted-foreground` because the band
 *  is a header rather than a floating caption. */
export const SECTION_BAND_LABEL_CLASS =
  'label-mono min-w-0 flex-1 truncate tracking-[.16em] text-muted-foreground'

function SectionBand({
  label,
  count,
  collapsed,
  onToggle,
  testId,
  countTestId,
  icon,
}: {
  label: string
  /** Rows in this section's open lane — the design's right-aligned count. */
  count: number
  collapsed: boolean
  onToggle: () => void
  testId: string
  countTestId?: string
  icon?: JSX.Element
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      data-testid={testId}
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-expanded={!collapsed}
      onClick={onToggle}
      title={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
      className={cn(
        SECTION_BAND_CLASS,
        'group/band transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px]',
      )}
    >
      {icon}
      {/* --muted-foreground, not --label: the band is a HEADER now, not a
          floating caption, and the design sets it a step darker to match. */}
      <span className={SECTION_BAND_LABEL_CLASS}>{label}</span>
      <ChevronRight
        size={11}
        aria-hidden="true"
        className={cn(
          'flex-none text-text-faint transition-[transform,opacity] duration-150',
          !collapsed && 'rotate-90',
          collapsed ? 'opacity-100' : 'opacity-0 group-hover/band:opacity-100',
        )}
      />
      {count > 0 && (
        <span
          className="shell-type-micro flex-none font-mono tabular-nums text-muted-foreground"
          data-testid={countTestId}
        >
          {count}
        </span>
      )}
    </button>
  )
}

/** Project section band. `first` is gone from the signature: a band owns its own
 *  top rule wherever it lands. */
export function ProjectGroupLabel({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <SectionBand
      label={label}
      count={count}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="project-group-label"
      countTestId="project-group-count"
    />
  )
}

/** PINNED section band (POD-166, R3): the one section above all project groups,
 *  and the only band with a mark — every other band is a project, so the pin is
 *  what says "this one is not". */
export function PinnedSectionLabel({
  count,
  collapsed,
  onToggle,
}: {
  count: number
  collapsed: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <SectionBand
      label="Pinned"
      count={count}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="pinned-section-label"
      icon={<Pin size={9} className="flex-none text-attention" aria-hidden="true" />}
    />
  )
}

export type WorkPlacement =
  | {
      lane: 'pinned' | 'open'
      groupKey: string
      groupLabel: string
      row: UnifiedWorkRow
    }
  | {
      lane: 'closed'
      groupKey: string
      groupLabel: string
      row: UnifiedIssueRowView
    }
  | {
      lane: 'snoozed'
      groupKey: string
      groupLabel: string
      row: UnifiedIssueRowView
    }

/**
 * THE DISCLOSURE, ANIMATED (POD-1253).
 *
 * Every fold in this column — the section bands, the snoozed tail, the closed
 * tail — used to be `{!collapsed && rows}`: thirty rows present in one frame and
 * absent in the next, with everything below them teleporting into the hole. The
 * band's chevron was the only part of the gesture that moved, which made the
 * turn read as a hiccup rather than as a fold.
 *
 * WHAT MOVES IS THE CLIP, NOT THE CONTENT. The panel animates its own height
 * from 0 to the content's natural height while clipping; the rows inside never
 * move, never squash and never re-lay-out. So the eye follows one edge sweeping
 * up the column, the rows below ride it exactly (they are `layout="position"`
 * elements whose `layoutDependency` does NOT bump on a fold — see
 * `SidebarUnified` — so Motion never measures and never animates a second,
 * competing interpolation against this one), and the text stays legible the
 * whole way down.
 *
 * `contain: layout paint` is not decoration: animating height relayouts every
 * frame, and without containment a webview is free to keep a stale tile of a
 * row mid-collapse (POD-1146, the Flight Deck's own height one-shot). It makes
 * the panel its own containing block and clips its subtree to it, so a shrinking
 * fold can never paint past its bounds however the frame lands.
 *
 * THE OPACITY IS NOT THE HEIGHT'S TWIN. A fade running the full length of the
 * collapse leaves half-transparent rows sliding under the band, which reads as
 * two things happening. Out is quick and front-loaded (the rows are gone before
 * the edge arrives); in is short and late (the space is made, then the rows
 * appear in it) — the shape a disclosure has when it feels like one surface
 * sliding over another rather than a list dissolving.
 */
/**
 * THE CURVE, MEASURED RATHER THAN CHOSEN BY NAME. The first cut used the
 * shell's usual `[0.32, 0.72, 0, 1]` expo-out, which is right for a chip
 * arriving and wrong for six hundred pixels of column: sampled frame by frame it
 * spent 76% of the travel in the first 18% of the time and then crawled the last
 * hundred pixels, which reads as a snap followed by a drift rather than as one
 * fold. `[0.4, 0, 0.2, 1]` is the standard accelerate-and-settle arc — ~14% of
 * the travel at a fifth of the way, ~62% at half, a soft landing — and over this
 * distance that is the one that reads as a single continuous movement.
 */
const FOLD_EASE = [0.4, 0, 0.2, 1] as const
const FOLD_IN = {
  height: { duration: 0.32, ease: FOLD_EASE },
  opacity: { duration: 0.22, delay: 0.06, ease: 'easeOut' as const },
}
const FOLD_OUT = {
  height: { duration: 0.26, ease: FOLD_EASE },
  opacity: { duration: 0.12, ease: 'easeIn' as const },
}

/**
 * NO `AnimatePresence` (POD-1253). The obvious spelling of this is
 * `<AnimatePresence>{open && <motion.div exit=… />}</AnimatePresence>`, and it
 * cost 27KB of eager source — enough to push the web bundle through its ratchet
 * (7,613,223 against a 7,600,000 ceiling), for one component's exit. The
 * repository's own precedent is to pay the eager bundle down rather than raise
 * the ratchet, so the presence machinery is replaced by the two lines it is
 * doing here: keep the subtree mounted while it plays its exit, drop it when the
 * exit lands. `motion.div` itself is already in this bundle several times over.
 */
export function FoldPanel({
  open,
  id,
  testId,
  dragScope,
  children,
}: {
  open: boolean
  id?: string
  testId?: string
  /** Optional manual-sort scope. When present, draggable rows must be direct
   *  children of this panel; useRowDrag relies on that boundary to exclude the
   *  nested snoozed/closed folds from the live-row order. */
  dragScope?: string
  children: ReactNode
}): JSX.Element | null {
  const reduceMotion = useReducedMotion()
  // Derived during render, not in an effect: an effect would mount the rows one
  // frame after the press, and that frame is visible at the head of a gesture
  // whose whole job is to feel immediate.
  const [rendered, setRendered] = useState(open)
  if (open && !rendered) setRendered(true)
  // The first paint of a column is not a disclosure: an open fold on load must
  // simply BE open, or every reload plays thirty rows unrolling. Only a fold
  // that has actually been toggled animates in, which is what this ref tracks —
  // it survives the inner element unmounting, because it lives out here.
  const settled = useRef(false)
  const firstPaint = !settled.current
  settled.current = true
  if (!rendered) return null
  return (
    <motion.div
      id={id}
      data-testid={testId}
      data-drag-scope={dragScope}
      className="min-w-0 overflow-hidden"
      style={{ contain: 'layout paint' }}
      initial={firstPaint ? false : { height: 0, opacity: 0 }}
      animate={
        open
          ? { height: 'auto', opacity: 1, transition: reduceMotion ? { duration: 0 } : FOLD_IN }
          : { height: 0, opacity: 0, transition: reduceMotion ? { duration: 0 } : FOLD_OUT }
      }
      onAnimationComplete={() => {
        // Only the CLOSING one retires the subtree; the opening animation
        // completes too, and unmounting there would shut the fold it just opened.
        if (!open) setRendered(false)
      }}
    >
      {children}
    </motion.div>
  )
}

export const ROW_LAYOUT_TRANSITION = {
  type: 'spring' as const,
  stiffness: 105,
  damping: 20,
  mass: 0.95,
}
export type TransitionWorkRow = RowTransitionItem<WorkPlacement>

/** How a folded row ended, in one dim mono word (POD-293). Merged is the common
 *  closed outcome; snooze shows the time left. Nothing here is an ask, so none
 *  of it is amber. */
export function foldedMarker(
  issue: IssueNavigationModel,
  lane: 'closed' | 'snoozed',
  now: number,
): string {
  if (lane === 'snoozed') {
    const until = issue.deferUntil ? Date.parse(issue.deferUntil) : NaN
    if (!Number.isFinite(until)) return 'snoozed'
    const mins = Math.max(0, Math.round((until - now) / 60000))
    if (mins < 60) return 'snoozed <1h'
    const hours = Math.round(mins / 60)
    if (hours < 24) return `snoozed ${hours}h`
    return `snoozed ${Math.round(hours / 24)}d`
  }
  if (issue.gitState?.merged) return 'merged'
  // One word, lowercased from the shared status vocabulary (POD-1074) — so a
  // row folded as `wontfix` in the store reads "cancelled" here, the same word
  // the status menu offers, instead of the third spelling ("won't fix") this
  // switch used to keep to itself.
  const reason = canonicalIssueCloseReason(issue.closedReason)
  if (reason && reason !== 'done') return ISSUE_STATUS_LABELS[reason].toLowerCase()
  return 'closed'
}

/** A folded (closed / suspended) issue on ONE dim line (POD-293): ref · title ·
 *  how it ended. Out of triage means no avatars, timers, pills, git or unread —
 *  the whole vocabulary of an open row drops away. Roughly half a live row's
 *  height, so a long archive scans in a glance. Clicking reopens the issue;
 *  the fold's own archive overlay still rides on top for closed rows. */
export function FoldedWorkRow({
  issue,
  lane,
  now,
  active,
  onSelect,
  onContextMenu,
}: {
  issue: IssueNavigationModel
  lane: 'closed' | 'snoozed'
  now: number
  active: boolean
  onSelect: () => void
  onContextMenu?: (e: ReactMouseEvent) => void
}): JSX.Element {
  const marker = foldedMarker(issue, lane, now)
  // How long ago the work entered this fold — manually tucked rows date from
  // the tuck, while never-tucked closures fall back to their finish time.
  // Suspended rows date from their last activity (POD-293). One dim
  // stamp so a fold still answers "when", without pulling any live-row chrome
  // back in.
  // Keep this source shared with grouping: Closed must not say "tucked 5m ago"
  // while placing the row by a days-old close time.
  const stampIso = lane === 'closed' ? issueClosedFoldAt(issue) : issue.updatedAt
  const ago = stampIso ? relativeTime(stampIso, now) : null
  return (
    <button
      data-pressable
      type="button"
      data-testid="folded-work-row"
      data-lane={lane}
      data-selected={active ? 'true' : 'false'}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={`${issueDisplayRef(issue)} · ${issue.title}`}
      className={cn(
        // Full-bleed like the live rows above it: same 13px inset, same 26px
        // number gutter, one line tall, no radius of its own.
        'group/crow flex w-full min-w-0 items-center gap-[11px] py-[3px] pr-8 pl-[13px] text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-muted',
      )}
    >
      <span
        className="shell-type-micro flex flex-none justify-end font-mono tabular-nums text-text-faint"
        style={{ width: ID_GUTTER_W }}
      >
        {issue.seq}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
        {issue.title}
      </span>
      <span className="shell-type-micro flex flex-none items-center gap-1.5 font-mono">
        <span className={cn(marker === 'merged' ? 'text-info/70' : 'text-text-faint')}>
          {marker}
        </span>
        {ago && <span className="tabular-nums text-text-dim">{ago}</span>}
      </span>
    </button>
  )
}

/** Project-local disclosure for actively deferred work. Disclosure changes
 * reuse the row-arrival one-shot: collapsing prunes the visible keys, so each
 * later expansion gets one fresh arrival without inventing another motion. */
export function SnoozedIssueFold({
  groupKey,
  rows,
  renderRow,
  settleTransition,
}: {
  groupKey: string
  rows: TransitionWorkRow[]
  renderRow: (row: TransitionWorkRow, animate: boolean) => JSX.Element
  settleTransition: (key: string, placement: string) => void
}): JSX.Element {
  const [collapsed, toggle] = useCollapsed(snoozedFoldKey(groupKey), true)
  const contentId = useId()
  const visibleKeys = collapsed ? [] : rows.map((row) => row.key)
  const { arrivals, settle } = useArrivals(visibleKeys)
  return (
    <div className="min-w-0" data-testid="snoozed-issue-fold">
      <button
        data-pressable
        type="button"
        className={TAIL_FOLD_CLASS}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        onClick={toggle}
        data-testid="snoozed-fold-toggle"
      >
        <span>{rows.length} snoozed</span>
        <span className="h-px min-w-4 flex-1 bg-hairline-soft" aria-hidden="true" />
        <ChevronRight
          size={13}
          className={cn('flex-none transition-transform duration-200', !collapsed && 'rotate-90')}
          aria-hidden="true"
        />
      </button>
      <FoldPanel open={!collapsed} id={contentId} testId="snoozed-fold-rows">
        <div className="min-w-0">
          {rows.map((row) => {
            const arriving = arrivals.has(row.key) || row.phase === 'entering'
            return (
              <div
                key={row.key}
                className={cn('min-w-0', arriving && 'row-arrive')}
                data-testid="snoozed-fold-row"
                onAnimationEnd={
                  arriving
                    ? (event) => {
                        if (event.animationName !== 'podium-arrive-wash') return
                        settle(row.key)
                        settleTransition(row.key, row.placement)
                      }
                    : undefined
                }
              >
                {renderRow(row, false)}
              </div>
            )
          })}
        </div>
      </FoldPanel>
    </div>
  )
}

/** Project-local disclosure for settled top-level closures (POD-183). Rows are
 * derived newest-tucked-first; Archive is the explicit removal gesture. */
export function ClosedIssueFold<T>({
  groupKey,
  rows,
  renderRow,
  issueForRow,
  onArchive,
}: {
  groupKey: string
  rows: T[]
  renderRow: (row: T) => JSX.Element
  issueForRow: (row: T) => UnifiedIssueRowView
  onArchive: (id: string) => void
}): JSX.Element {
  const [collapsed, toggle] = useCollapsed(closedFoldKey(groupKey), true)
  const contentId = useId()
  const issueRows = rows.map(issueForRow)
  // NO IN-FLIGHT ARCHIVE SET (POD-781). This fold used to take one, to disable
  // the buttons and fade their icons while the server was asked. Archiving is
  // outboxed now: the row is gone from `rows` on the press, so a "still
  // archiving" state has nobody to describe — and a control whose only job was
  // to look busy during a wait that no longer happens is not a control.
  const archiveAll = (event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    for (const row of issueRows) onArchive(row.issue.id)
  }
  return (
    <div className="min-w-0" data-testid="closed-issue-fold">
      <div className="group/fold relative flex items-center">
        <button
          data-pressable
          type="button"
          className={TAIL_FOLD_CLASS}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={toggle}
          data-testid="closed-fold-toggle"
        >
          <span>{rows.length} closed</span>
          <span className="h-px min-w-4 flex-1 bg-hairline-soft" aria-hidden="true" />
          <ChevronRight
            size={13}
            className={cn('flex-none transition-transform duration-200', !collapsed && 'rotate-90')}
            aria-hidden="true"
          />
        </button>
        {/* The chip used to read `All` and sit at `right-13`, which is exactly
         * where the chevron is: hovering the fold hid the one control that says
         * whether it opens or shuts, and put a destructive press under the
         * cursor that was aiming for the disclosure. It reads `Archive all` now
         * — a verb, so it does not need the icon to be legible — and parks on
         * the hairline to the LEFT of the chevron, which stays visible and
         * clickable the whole time the chip is up. */}
        <button
          data-pressable
          data-hover-reveal
          type="button"
          aria-label={`Archive all ${issueRows.length} closed issues`}
          title="Archive all closed issues"
          onClick={archiveAll}
          className="shell-type-micro absolute right-[34px] bottom-0 flex h-5 items-center gap-1 rounded-[5px] border border-hairline-bar bg-chip px-1.5 font-mono font-medium tracking-[.02em] text-label opacity-0 shadow-sm transition-[color,opacity,background-color] duration-100 group-hover/fold:opacity-100 group-focus-within/fold:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong disabled:pointer-events-none disabled:opacity-0"
          data-testid="closed-issues-archive-all"
        >
          <Archive size={10} aria-hidden="true" />
          <span>Archive all</span>
        </button>
      </div>
      <FoldPanel open={!collapsed} id={contentId} testId="closed-fold-rows">
        <div className="min-w-0">
          {rows.map((row) => {
            const issueRow = issueForRow(row)
            return (
              <div
                key={issueRow.issue.id}
                className="group/closed relative min-w-0"
                data-testid="closed-fold-row"
              >
                {renderRow(row)}
                <button
                  data-pressable
                  type="button"
                  data-hover-reveal
                  // Sized and centred to the one-line folded row (POD-293): a
                  // 20px control vertically centred at the right inset, not the
                  // old tall-row top offset that hung off a 26px line.
                  className="absolute top-1/2 right-2.5 z-20 flex size-5 -translate-y-1/2 items-center justify-center rounded-[5px] border border-hairline-bar bg-chip text-label opacity-0 shadow-sm transition-[color,opacity,background-color] group-hover/closed:opacity-100 group-focus-within/closed:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong"
                  aria-label={`Archive ${issueDisplayRef(issueRow.issue)}`}
                  title="Archive — remove from sidebar"
                  data-testid="closed-issue-archive"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onArchive(issueRow.issue.id)
                  }}
                >
                  <Archive size={11} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      </FoldPanel>
    </div>
  )
}
