/**
 * The tab/row status grammar of the redesign (.design/specs/native-pane.md
 * §2.8): one component so the desktop tab strip, the mobile panel-menu rows
 * and any future surface render the exact same signal —
 *
 *   working        → the working mark (the only ongoing motion; reserved blue)
 *   waiting on you → amber stillness: a plain 6px dot on desktop tabs, a
 *                    13px (optionally numbered) amber pill on menu rows
 *   idle / done    → nothing — stillness is the signal
 *
 * Semantic colours only (reserved amber/green, see lib/issueColors.ts) — the
 * glyph must never pick up the issue colour. Corner badges on ID squares/rails
 * remain StatusBadge's job.
 */
import { motionPhase } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model/browser'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { WorkingMark } from './WorkingMark'

export function AgentStatusGlyph({
  session,
  variant = 'tab',
  count,
  className,
}: {
  session: SessionMeta
  /** 'tab' = desktop tab strip (dot, 15px mark) · 'row' = menu/list rows
   *  (numbered pill, 13px mark). */
  variant?: 'tab' | 'row'
  /** Optional waiting count for the row pill; absent renders the pill unnumbered. */
  count?: number
  className?: string
}): JSX.Element | null {
  const phase = motionPhase(session)
  if (phase === 'working') {
    // One mark, two surfaces. A tab and the transcript it leads to are one
    // signal seen from two places; rows are the same signal in a denser line.
    // The only difference left between them is the size of the cell.
    return <WorkingMark size={variant === 'tab' ? 15 : 13} className={cn('flex-none', className)} />
  }
  if (phase !== 'waiting') return null
  if (variant === 'row') {
    return (
      <span
        role="img"
        aria-label={count ? `${count} waiting on you` : 'waiting on you'}
        className={cn(
          'inline-flex h-[13px] min-w-[13px] flex-none items-center justify-center rounded-full px-[3px] font-mono shell-type-micro font-bold',
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
