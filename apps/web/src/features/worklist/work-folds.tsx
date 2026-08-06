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

/**
 * The redesigned work sidebar (#41, .design/specs/sidebar.md): the
 * `New <Agent> in <Repo>` spawn row over ONE list of work rows grouped by
 * project (mono section labels), each row carrying its ID square, two-line
 * status anatomy, motion-grammar meta and — when selected — the bridge notch
 * growing toward the engraved column.
 *
 * The pieces are exported separately because the collapsed rail shares their
 * hooks and row behavior.
 */
/**
 * The worklist derivation, as READ rather than as COMPUTED (POD-331).
 *
 * This used to be a `useMemo` over `(repos, sessions, pins, issues, now)` whose
 * result every consumer had to be HANDED as a `derivationOverride` prop — and
 * whose absence, in any consumer that did not receive it, silently bought a
 * second execution of the identical derivation on a private clock. It is now a
 * read of the published `worklistSlice`: one derivation per snapshot however
 * many surfaces are looking, and one clock (`Store.coarseNow`) so two surfaces
 * cannot disagree about when "now" is.
 *
 * The type alias stays so the override-taking signatures below keep reading the
 * same way; the shape is the slice's.

/** Project section label: mono 8.5px uppercase over a trailing hairline (§2.2).
 *  Grouping is always on — no toggle, no chevron, no collapse. */
export function ProjectGroupLabel({
  label,
  first,
}: {
  label: string
  first: boolean
}): JSX.Element {
  return (
    <div
      data-testid="project-group-label"
      className={cn(
        'shell-type-micro flex items-center gap-1.5 px-1 pb-0.5 font-mono tracking-[.12em] uppercase text-label',
        first ? 'pt-1' : 'pt-2',
      )}
    >
      <span className="truncate">{label}</span>
      <span className="h-px min-w-4 flex-1 bg-hairline-soft" aria-hidden="true" />
    </div>
  )
}

/** PINNED section label (POD-166, R3): the one section above all project
 *  groups — same mono hairline voice, led by an attention-toned pin. */
export function PinnedSectionLabel(): JSX.Element {
  return (
    <div
      data-testid="pinned-section-label"
      className="shell-type-micro flex items-center gap-1.5 px-1 pt-1 pb-0.5 font-mono tracking-[.12em] uppercase text-label"
    >
      <Pin size={9} className="flex-none text-attention" aria-hidden="true" />
      <span>Pinned</span>
      <span className="h-px min-w-4 flex-1 bg-hairline-soft" aria-hidden="true" />
    </div>
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
  // suspended rows from their last activity (POD-293). One dim stamp so a fold
  // still answers "when", without pulling any live-row chrome back in.
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
        'group/crow flex w-full min-w-0 items-center gap-2.5 rounded-[6px] px-2 py-[3px] pr-8 text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-muted',
      )}
    >
      <span className="shell-type-micro flex-none font-mono font-semibold tracking-[.02em] tabular-nums text-text-faint">
        {issueDisplayRef(issue)}
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
        className="group/fold flex min-h-[31px] w-full items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-left font-mono text-[10px] font-medium tracking-[.035em] text-text-faint hover:text-muted-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px]"
        aria-expanded={!collapsed}
        aria-controls={contentId}
        onClick={toggle}
        data-testid="snoozed-fold-toggle"
      >
        <ChevronRight
          size={11}
          className={cn('flex-none transition-transform duration-150', !collapsed && 'rotate-90')}
          aria-hidden="true"
        />
        <span>Snoozed · {rows.length}</span>
        <span className="h-px min-w-4 flex-1 bg-hairline-soft" aria-hidden="true" />
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
  archivingIssueIds,
  onArchive,
}: {
  groupKey: string
  rows: T[]
  renderRow: (row: T) => JSX.Element
  issueForRow: (row: T) => UnifiedIssueRowView
  archivingIssueIds: ReadonlySet<string>
  onArchive: (id: string) => void
}): JSX.Element {
  const [collapsed, toggle] = useCollapsed(closedFoldKey(groupKey), true)
  const contentId = useId()
  const issueRows = rows.map(issueForRow)
  const allArchiving = issueRows.every((row) => archivingIssueIds.has(row.issue.id))
  const archiveAll = (event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    for (const row of issueRows) {
      if (!archivingIssueIds.has(row.issue.id)) onArchive(row.issue.id)
    }
  }
  return (
    <div className="min-w-0" data-testid="closed-issue-fold">
      <div className="group/fold relative flex min-h-[31px] items-center">
        <button
          data-pressable
          type="button"
          className="flex min-h-[31px] w-full items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-left font-mono text-[10px] font-medium tracking-[.035em] text-text-faint hover:text-muted-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px]"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={toggle}
          data-testid="closed-fold-toggle"
        >
          <ChevronRight
            size={11}
            className={cn('flex-none transition-transform duration-150', !collapsed && 'rotate-90')}
            aria-hidden="true"
          />
          <span>Closed · {rows.length}</span>
          <span className="h-px min-w-4 flex-1 bg-hairline-soft" aria-hidden="true" />
        </button>
        <button
          data-pressable
          data-hover-reveal
          type="button"
          aria-label={`Archive all ${issueRows.length} closed issues`}
          title="Archive all closed issues"
          disabled={allArchiving}
          onClick={archiveAll}
          className="absolute right-1.5 flex h-5 items-center gap-1 rounded-[5px] border border-hairline-bar bg-chip px-1.5 font-mono text-[9px] font-medium tracking-[.02em] text-label opacity-0 shadow-sm transition-[color,opacity,background-color] duration-100 group-hover/fold:opacity-100 group-focus-within/fold:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong disabled:pointer-events-none disabled:opacity-0"
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
            const archiving = archivingIssueIds.has(issueRow.issue.id)
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
                  className="absolute top-1/2 right-1.5 z-20 flex size-5 -translate-y-1/2 items-center justify-center rounded-[5px] border border-hairline-bar bg-chip text-label opacity-0 shadow-sm transition-[color,opacity,background-color] group-hover/closed:opacity-100 group-focus-within/closed:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong"
                  aria-label={`Archive ${issueDisplayRef(issueRow.issue)}`}
                  title="Archive — remove from sidebar"
                  data-testid="closed-issue-archive"
                  disabled={archiving}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onArchive(issueRow.issue.id)
                  }}
                >
                  <Archive
                    size={11}
                    className={cn('transition-opacity duration-100', archiving && 'opacity-0')}
                    aria-hidden="true"
                  />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
