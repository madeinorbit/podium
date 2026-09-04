import { ISSUE_STATUS_LABELS, type IssueStage, type IssueStatus } from '@podium/model/browser'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/** First letters of the first two words ('.', '-', '_' count as separators). */
export function assigneeInitials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  const s = words
    .slice(0, 2)
    .map((w) => (w[0] ?? '').toUpperCase())
    .join('')
  return s || '?'
}

// Fill fraction per open stage for the Linear-style progress-circle glyph
// family. The terminal statuses are not on this ramp — they are marks.
const STAGE_FILL: Record<IssueStage, number> = {
  proposed: 0,
  backlog: 0,
  planning: 0,
  in_progress: 1 / 3,
  review: 2 / 3,
  shipping: 5 / 6,
  done: 1,
}

const STATUS_CLASS: Record<IssueStatus, string> = {
  proposed: 'text-fuchsia-500',
  backlog: 'text-muted-foreground/70',
  planning: 'text-muted-foreground',
  in_progress: 'text-blue-500',
  review: 'text-sky-500',
  shipping: 'text-violet-500',
  done: 'text-success',
  // THE CANCELLED FAMILY IS MUTED, NEVER GREEN (POD-1074). Success is the
  // colour of work that landed. Before the split, an issue closed as `wontfix`
  // wore the same filled green tick as one that shipped — the sidebar could not
  // tell "we did it" from "we decided not to", which is exactly what a terminal
  // status is for.
  cancelled: 'text-muted-foreground',
  duplicate: 'text-muted-foreground',
  superseded: 'text-muted-foreground',
}

/** The knocked-out mark inside a filled circle, per terminal status. */
function terminalMark(status: 'done' | 'cancelled' | 'duplicate' | 'superseded'): JSX.Element {
  const ko = 'var(--background)'
  if (status === 'done') {
    return (
      <path
        d="M4.5 7.2 6.3 9l3.2-3.6"
        stroke={ko}
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  }
  if (status === 'duplicate') {
    // The copy mark: a filled front card with the back card's corner bracket
    // showing behind it. Reads as "this one already exists over there" without
    // borrowing the cancelled ✕, which would make two adjacent picker rows wear
    // the same glyph.
    return (
      <>
        <path
          d="M4.3 9.1V5.2a.95.95 0 0 1 .95-.95h3.9"
          stroke={ko}
          strokeWidth="1.25"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="5.9" y="5.9" width="4.1" height="4.1" rx="1.05" fill={ko} />
      </>
    )
  }
  if (status === 'superseded') {
    // Replaced, not abandoned: an arrow leaving the circle to the right.
    return (
      <path
        d="M4.4 7h4.5M7.1 5.2 8.9 7l-1.8 1.8"
        stroke={ko}
        strokeWidth="1.45"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  }
  return (
    <path d="M5 5l4 4M9 5l-4 4" stroke={ko} strokeWidth="1.55" fill="none" strokeLinecap="round" />
  )
}

/**
 * Linear-style workflow-state glyph: dashed circle (backlog), open circle
 * (planning), pie-fill circles (in_progress/review), and a filled disc carrying
 * a knocked-out mark for each terminal status — check (done), ✕ (cancelled),
 * copy (duplicate), arrow (superseded).
 */
export function StatusGlyph({
  status,
  size = 14,
  decorative = false,
}: {
  status: IssueStatus
  size?: number
  /**
   * Hide the glyph from assistive tech, for the surfaces that already spell the
   * status out in text right beside it — a status menu's rows, where the named
   * graphic made every item announce its word twice ("Backlog Backlog") and put
   * the item's accessible name out of reach of anything asking for it by name
   * (POD-1646).
   */
  decorative?: boolean
}): JSX.Element {
  const label = ISSUE_STATUS_LABELS[status]
  // The name STAYS on the element and `aria-hidden` is what does the hiding: an
  // aria-hidden subtree is skipped whole when a name is computed, so the row
  // above is named by its word and nothing else. Dropping `role`/`aria-label`
  // instead would read more plainly here, but it leaves the lint rule that
  // guards every OTHER caller's alternative text unable to see one.
  const hidden = decorative || undefined
  const cls = cn('shrink-0', STATUS_CLASS[status])
  if (
    status === 'done' ||
    status === 'cancelled' ||
    status === 'duplicate' ||
    status === 'superseded'
  ) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 14 14"
        className={cls}
        role="img"
        aria-label={label}
        aria-hidden={hidden}
      >
        <circle cx="7" cy="7" r="6" fill="currentColor" />
        {terminalMark(status)}
      </svg>
    )
  }
  const stage: IssueStage = status
  const fill = STAGE_FILL[stage]
  // Pie slice from 12 o'clock, clockwise, for the fractional stages.
  const angle = 2 * Math.PI * fill
  const x = 7 + 3.2 * Math.sin(angle)
  const y = 7 - 3.2 * Math.cos(angle)
  const largeArc = fill > 0.5 ? 1 : 0
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      className={cls}
      role="img"
      aria-label={label}
      aria-hidden={hidden}
    >
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray={stage === 'backlog' ? '2.2 2.2' : undefined}
      />
      {fill > 0 && (
        <path d={`M7 7 L7 3.8 A3.2 3.2 0 ${largeArc} 1 ${x} ${y} Z`} fill="currentColor" />
      )}
    </svg>
  )
}

/**
 * The STAGE-only door onto {@link StatusGlyph}, for the surfaces that hold a
 * stage and nothing else — a resolved `POD-…` chip, a board column header, a
 * filter row. Where the row's `closedReason` IS in hand, call `StatusGlyph`
 * with `issueStatusOf(issue)` instead: a cancelled issue passed through here
 * still draws the green Done tick, because a bare stage genuinely cannot tell
 * the two apart.
 */
export function StageGlyph({
  stage,
  size = 14,
}: {
  stage: IssueStage
  size?: number
}): JSX.Element {
  return <StatusGlyph status={stage} size={size} />
}

/**
 * The sixth glyph in the family: a ref this client cannot answer for (POD-676).
 *
 * Not a stage — the ring carries a question mark instead of a stage's fill, so
 * "we do not know" is a shape of its own rather than a stage worn in grey. A
 * dashed ring was the old fallback and it is exactly the backlog glyph, which
 * made a replica gap read as a real workflow state at a glance; the colour alone
 * was never going to separate them, because backlog is muted too.
 *
 * Same 14-unit viewBox and r=6 ring at 1.6 as StageGlyph, so it sits at the same
 * optical weight beside the stages it must NOT be mistaken for.
 */
export function UnknownRefGlyph({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      className="shrink-0 text-muted-foreground"
      role="img"
      aria-label="Unknown"
    >
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5.3 5.0a1.75 1.75 0 0 1 3.4 0.58c0 1.17-1.75 1.75-1.75 1.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="9.7" r="0.85" fill="currentColor" />
    </svg>
  )
}

/** Linear-style priority glyph: P0 urgent box, P1–P3 signal bars, P4 muted. */
export function PriorityGlyph({
  priority,
  size = 14,
}: {
  priority: number
  size?: number
}): JSX.Element {
  const label = `P${priority}`
  if (priority === 0) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 14 14"
        className="shrink-0 text-orange-500"
        role="img"
        aria-label={label}
      >
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <path d="M7 3.6v4.2" stroke="var(--background)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="7" cy="10.4" r="1" fill="var(--background)" />
      </svg>
    )
  }
  // Bars lit: P1=3, P2=2, P3=1, P4=0.
  const lit = Math.max(0, 4 - priority)
  const bar = (i: number): JSX.Element => (
    <rect
      key={i}
      x={1.5 + i * 4}
      y={9 - i * 3}
      width="2.6"
      height={3 + i * 3}
      rx="1"
      fill="currentColor"
      opacity={i < lit ? 1 : 0.25}
    />
  )
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      className="shrink-0 text-muted-foreground"
      role="img"
      aria-label={label}
    >
      {[0, 1, 2].map(bar)}
    </svg>
  )
}

/** Initials avatar; dotted outline when unassigned (Linear's placeholder). */
export function AssigneeAvatar({
  assignee,
  size = 18,
}: {
  assignee?: string
  size?: number
}): JSX.Element {
  if (!assignee) {
    return (
      <span
        aria-label="Unassigned"
        title="Unassigned"
        className="inline-block shrink-0 rounded-full border border-muted-foreground/50 border-dashed"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      aria-label={`Assignee: ${assignee}`}
      title={assignee}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-medium shell-type-micro text-primary"
      style={{ width: size, height: size }}
    >
      {assigneeInitials(assignee)}
    </span>
  )
}
