/**
 * The issue page's shared chrome — a section heading and a status pill.
 *
 * POD-591 moved the heading onto the documented machine-voice label style
 * (`label-mono`: 8.5px Geist Mono, 0.12em, Label Grey) instead of the 11px sans
 * it used to invent. Section labels are the system talking about itself, which
 * DESIGN.md's Machine Voice Rule assigns to the mono face, and the page now has
 * eight of them — at 11px sans they competed with the 13px prose they label.
 */
import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Uniform section label; `count` renders as a quiet tabular badge, `action` as
 *  a trailing control that only surfaces on section hover (`group-hover`). */
export function SectionHeading({
  children,
  count,
  action,
}: {
  children: ReactNode
  count?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <h3 className="label-mono">{children}</h3>
      {count !== undefined && (
        <span className="font-mono text-[9px] text-text-faint tabular-nums">{count}</span>
      )}
      {action && (
        <div className="ml-auto opacity-0 transition-opacity focus-within:opacity-100 group-hover/section:opacity-100">
          {action}
        </div>
      )}
    </div>
  )
}

/**
 * One quiet pill in the dossier line.
 *
 * The dossier renders ORDINARY facts (stage, type, timestamps) as plain mono
 * text and reserves this pill for the exceptions — draft, pinned, internal,
 * agent-created, a stale hub mirror. Before POD-591 every fact was a pill, and
 * a strip where everything is emphasised emphasises nothing.
 */
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
    muted: 'bg-muted/50 text-muted-foreground',
    amber: 'bg-attention/12 text-attention',
    violet: 'bg-violet-500/12 text-violet-600 dark:text-violet-300',
    sky: 'bg-info/12 text-info',
  } as const
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-[4px] px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.04em]',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}
