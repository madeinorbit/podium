import type { IssueStage } from '@podium/protocol'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { STAGE_LABELS } from './issue-card'

/** First letters of the first two words ('.', '-', '_' count as separators). */
export function assigneeInitials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  const s = words
    .slice(0, 2)
    .map((w) => (w[0] ?? '').toUpperCase())
    .join('')
  return s || '?'
}

// Fill fraction per stage for the Linear-style progress-circle glyph family.
const STAGE_FILL: Record<IssueStage, number> = {
  backlog: 0,
  planning: 0,
  in_progress: 1 / 3,
  review: 2 / 3,
  done: 1,
}

const STAGE_CLASS: Record<IssueStage, string> = {
  backlog: 'text-muted-foreground/70',
  planning: 'text-muted-foreground',
  in_progress: 'text-amber-500',
  review: 'text-sky-500',
  done: 'text-success',
}

/**
 * Linear-style workflow-state glyph: dashed circle (backlog), open circle
 * (planning), pie-fill circles (in_progress/review), check (done).
 */
export function StageGlyph({ stage, size = 14 }: { stage: IssueStage; size?: number }): JSX.Element {
  const label = STAGE_LABELS[stage]
  const cls = cn('shrink-0', STAGE_CLASS[stage])
  if (stage === 'done') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className={cls} role="img" aria-label={label}>
        <circle cx="7" cy="7" r="6" fill="currentColor" />
        <path d="M4.5 7.2 6.3 9l3.2-3.6" stroke="var(--background)" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  const fill = STAGE_FILL[stage]
  // Pie slice from 12 o'clock, clockwise, for the fractional stages.
  const angle = 2 * Math.PI * fill
  const x = 7 + 3.2 * Math.sin(angle)
  const y = 7 - 3.2 * Math.cos(angle)
  const largeArc = fill > 0.5 ? 1 : 0
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={cls} role="img" aria-label={label}>
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

/** Linear-style priority glyph: P0 urgent box, P1–P3 signal bars, P4 muted. */
export function PriorityGlyph({ priority, size = 14 }: { priority: number; size?: number }): JSX.Element {
  const label = `P${priority}`
  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0 text-orange-500" role="img" aria-label={label}>
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
    <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0 text-muted-foreground" role="img" aria-label={label}>
      {[0, 1, 2].map(bar)}
    </svg>
  )
}

/** Initials avatar; dotted outline when unassigned (Linear's placeholder). */
export function AssigneeAvatar({ assignee, size = 18 }: { assignee?: string; size?: number }): JSX.Element {
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
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-medium text-[9px] text-primary"
      style={{ width: size, height: size }}
    >
      {assigneeInitials(assignee)}
    </span>
  )
}
