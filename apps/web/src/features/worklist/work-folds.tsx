import { relativeTime } from '@podium/client-core/focus'
import type {
  IssueNavigationModel,
  UnifiedIssueRow as UnifiedIssueRowView,
  UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import { issueDisplayRef } from '@podium/protocol'
import { Archive, ChevronRight, Pin } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useId } from 'react'
import { type RowTransitionItem, useArrivals } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { closedFoldKey, snoozedFoldKey } from './fold-keys'
import { useCollapsed } from './sidebar-common'
import { ID_GUTTER_W } from './WorkRowShell'

/** The two TAIL folds — suspended work, settled closures — in the 3a voice: a
 *  count, a rule, the chevron holding its right end. `12 closed`, not
 *  `Closed · 12`: the quantity is what you are deciding about, and leading with
 *  the label made these look like the SECTION BANDS, which own a name. */
const TAIL_FOLD_CLASS =
  'flex w-full items-center gap-[9px] px-[13px] pb-1 text-left font-mono text-[10px] tracking-[.02em] tabular-nums text-text-faint hover:text-muted-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px]'

/**
 * THE SECTION BAND (POD-1057, the 3a design).
 *
 * It was a label floating on the column's ground — fine while every row under it
 * drew a hairline, but with the rules gone (see `WorkRowShell`) the labels were
 * the only structure left in a 30-row column and the lightest marks in it. So it
 * became a BAND: 34px, full-bleed, `--muted`, and a hairline UNDER it. It had a
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
 *  34px/`--muted`/hairline would drift the moment one of them is retuned. */
export const SECTION_BAND_CLASS =
  'flex h-[34px] w-full flex-none items-center gap-2 border-b border-hairline-bar bg-muted px-[13px] text-left'

/** The gap ABOVE a section that is not the first (POD-1078, the design's 14px).
 *  The band already said where a group STARTS; nothing said where one ended, so
 *  a project's last row and the next project's band met on a single hairline and
 *  the two groups read as one run. 14px of the column's ground parts them, and
 *  it stays well under the band's 34px so the band is still the thing you see
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
  switch (issue.closedReason) {
    case 'superseded':
      return 'superseded'
    case 'duplicate':
      return 'duplicate'
    case 'wontfix':
      return "won't fix"
    default:
      return 'closed'
  }
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
  // How long ago the work was last touched — closed rows date from the close,
  // suspended rows from their last activity (POD-293). One dim
  // stamp so a fold still answers "when", without pulling any live-row chrome
  // back in.
  const stampIso = lane === 'closed' ? (issue.closedAt ?? issue.updatedAt) : issue.updatedAt
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
        className={cn(TAIL_FOLD_CLASS, 'pt-3')}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        onClick={toggle}
        data-testid="snoozed-fold-toggle"
      >
        <span>{rows.length} snoozed</span>
        <span className="h-px min-w-4 flex-1 bg-hairline-soft" aria-hidden="true" />
        <ChevronRight
          size={12}
          className={cn('flex-none transition-transform duration-150', !collapsed && 'rotate-90')}
          aria-hidden="true"
        />
      </button>
      {!collapsed && (
        <div id={contentId} className="min-w-0" data-testid="snoozed-fold-rows">
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
      )}
    </div>
  )
}

/** Project-local disclosure for settled top-level closures (POD-183). Rows are
 * derived newest-closed-first; Archive is the explicit removal gesture. */
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
          className={cn(TAIL_FOLD_CLASS, 'pt-4')}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={toggle}
          data-testid="closed-fold-toggle"
        >
          <span>{rows.length} closed</span>
          <span className="h-px min-w-4 flex-1 bg-hairline-soft" aria-hidden="true" />
          <ChevronRight
            size={12}
            className={cn('flex-none transition-transform duration-150', !collapsed && 'rotate-90')}
            aria-hidden="true"
          />
        </button>
        <button
          data-pressable
          data-hover-reveal
          type="button"
          aria-label={`Archive all ${issueRows.length} closed issues`}
          title="Archive all closed issues"
          onClick={archiveAll}
          className="shell-type-micro absolute right-[13px] bottom-0 flex h-5 items-center gap-1 rounded-[5px] border border-hairline-bar bg-chip px-1.5 font-mono font-medium tracking-[.02em] text-label opacity-0 shadow-sm transition-[color,opacity,background-color] duration-100 group-hover/fold:opacity-100 group-focus-within/fold:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong disabled:pointer-events-none disabled:opacity-0"
          data-testid="closed-issues-archive-all"
        >
          <Archive size={10} aria-hidden="true" />
          <span>All</span>
        </button>
      </div>
      {!collapsed && (
        <div id={contentId} className="min-w-0" data-testid="closed-fold-rows">
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
      )}
    </div>
  )
}
