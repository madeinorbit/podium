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
import type { SessionMeta } from '@podium/model/browser'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { BrailleSpinner } from './BrailleSpinner'
import { BreathingMark } from './BreathingMark'

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
    // THE TAB BREATHES (POD-993). The chat's own tail and the tab that leads to
    // it are one signal seen from two places, so they move the same way: a tab
    // whose session is working carries the breath, not a second, differently
    // shaped spinner. List and menu rows keep the braille glyph — they are dense
    // mono lines, and the breath is a mark for a place the eye rests on.
    if (variant === 'tab') return <BreathingMark size={14} className={cn('flex-none', className)} />
    return <BrailleSpinner size={10} className={cn('flex-none', className)} />
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
