/**
 * The tab/row status grammar of the redesign (.design/specs/native-pane.md
 * §2.8): one component so the desktop tab strip, the mobile panel-menu rows
 * and any future surface render the exact same signal —
 *
 *   working        → braille spinner (the only ongoing motion; reserved green)
 *   waiting on you → amber stillness: a plain 6px dot on desktop tabs, a
 *                    13px (optionally numbered) amber pill on menu rows
 *   idle / done    → nothing — stillness is the signal
 *
 * Semantic colours only (reserved amber/green, see lib/issueColors.ts) — the
 * glyph must never pick up the issue colour. Corner badges on ID squares/rails
 * remain StatusBadge's job.
 */
import { motionPhase } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/protocol'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { BrailleSpinner } from './BrailleSpinner'

export function AgentStatusGlyph({
  session,
  variant = 'tab',
  count,
  className,
}: {
  session: SessionMeta
  /** 'tab' = desktop tab strip (dot, 9px spinner) · 'row' = menu/list rows
   *  (numbered pill, 10px spinner). */
  variant?: 'tab' | 'row'
  /** Optional waiting count for the row pill; absent renders the pill unnumbered. */
  count?: number
  className?: string
}): JSX.Element | null {
  const phase = motionPhase(session)
  if (phase === 'working') {
    return (
      <BrailleSpinner size={variant === 'row' ? 10 : 9} className={cn('flex-none', className)} />
    )
  }
  if (phase !== 'waiting') return null
  if (variant === 'row') {
    return (
      <span
        role="img"
        aria-label={count ? `${count} waiting on you` : 'waiting on you'}
        className={cn(
          'inline-flex h-[13px] min-w-[13px] flex-none items-center justify-center rounded-full px-[3px] font-mono text-[7.5px] font-bold',
          className,
        )}
        style={{ background: 'var(--motion-waiting)', color: 'var(--motion-waiting-ink)' }}
      >
        {count ?? ''}
      </span>
    )
  }
  return (
    <span
      role="img"
      aria-label="waiting on you"
      className={cn('size-[6px] flex-none rounded-full', className)}
      style={{ background: 'var(--motion-waiting)' }}
    />
  )
}
