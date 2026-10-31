import type { SessionView } from '@podium/client-core/session-values'

import { motionPhase } from '@podium/client-core/values'

import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { WorkingMark } from './WorkingMark'

export function AgentStatusGlyph({
  session,
  variant = 'tab',
  count,
  className,
}: {
  session: SessionView
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
