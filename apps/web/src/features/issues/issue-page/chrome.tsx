/**
 * The issue page's two pieces of shared chrome — a section heading and a status
 * pill. Both were declared inside IssuePage.tsx and read by four of the sections
 * that POD-646 split out of it, so they land here rather than being passed down
 * or duplicated per section.
 */
import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Uniform small-caps section heading; `count` renders as a quiet tabular badge. */
export function SectionHeading({
  children,
  count,
}: {
  children: ReactNode
  count?: string
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
        {children}
      </h3>
      {count !== undefined && (
        <span className="font-mono text-[11px] text-muted-foreground/70 tabular-nums">{count}</span>
      )}
    </div>
  )
}

/** One quiet pill in the status strip. */
export function StatusChip({
  children,
  tone = 'muted',
  title,
}: {
  children: ReactNode
  tone?: 'muted' | 'amber' | 'violet' | 'sky'
  title?: string
}): JSX.Element {
  const tones = {
    muted: 'border-border bg-muted/40 text-muted-foreground',
    amber: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    violet: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
    sky: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  } as const
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}
