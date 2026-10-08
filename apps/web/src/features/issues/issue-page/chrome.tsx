/**
 * The issue page's shared chrome — a section heading and a status pill.
 *
 * Utility headings use the documented machine voice. Narrative headings are a
 * deliberate second tier for human-authored fields: Design, Acceptance, and
 * Notes should read as part of the document rather than diagnostic chrome.
 */
import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The machine voice on this page, one definition.
 *
 * The global `label-mono` utility sets 8.5px, which is tuned for the denser
 * shells (the panel, the handover pane) and reads as a footnote against this
 * page's larger prose. This page steps it to 10px — so it must be a token
 * rather than a string copied per call site, or the labels drift apart the
 * next time one of them is touched.
 */
export const MACHINE_LABEL = 'font-mono text-[10px] text-text-dim uppercase tracking-[0.1em]'

/**
 * The machine voice one rung DOWN, for a label nested under another label.
 *
 * The rail's Relations band prints `RELATIONS` and then `BLOCKS` / `BLOCKED BY`
 * beneath it, and both were `MACHINE_LABEL` — identical size, case, tracking and
 * ink, so the band's own name and the groups inside it read as siblings. The
 * step moves on INK alone (dim → faint) rather than on size: at 10px mono a
 * second size step is a different label system, whereas one rung of ink is the
 * same voice, spoken more quietly. Same reason the Agent-notes caption uses it.
 */
export const MACHINE_LABEL_SUB = 'font-mono text-[10px] text-text-faint uppercase tracking-[0.1em]'

/** Uniform section label; `count` renders as a quiet tabular badge, `action` as
 *  a trailing control that only surfaces on section hover (`group-hover`). */
export function SectionHeading({
  children,
  count,
  action,
  tone = 'utility',
}: {
  children: ReactNode
  count?: string
  action?: ReactNode
  tone?: 'utility' | 'narrative'
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <h3
        className={cn(
          // Two axes, per DESIGN.md's Reading-Tier constraint: this sat at the
          // body's own 14.5px in the body's own ink, so a Design heading and the
          // Design text under it were separated by weight alone.
          tone === 'narrative'
            ? 'font-semibold text-[15px] text-foreground tracking-[-0.008em]'
            : MACHINE_LABEL,
        )}
      >
        {children}
      </h3>
      {count !== undefined && (
        <span className="font-mono text-[10px] text-text-faint tabular-nums">{count}</span>
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
        'inline-flex items-center gap-1 rounded-[4px] px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.04em]',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}
