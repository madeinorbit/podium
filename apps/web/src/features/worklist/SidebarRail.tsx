

import type { MotionPhase } from '@podium/client-core/values'
import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import type { IdSquareBadge } from '@/components/IdSquare'
import { MENU_HOVER_CARD } from '@/lib/menu-surface'
import { cn } from '@/lib/utils'

import { PoolSidebarRail } from './pool-sidebar-rail'

export function railBadge(phase: MotionPhase, waitingCount: number): IdSquareBadge | null {
  if (waitingCount > 0) return { kind: 'count', count: waitingCount }
  if (phase === 'working') return { kind: 'spinner' }
  if (phase === 'done') return { kind: 'check' }
  return null
}

/**
 * The selected mark's spine — the wide row's 3px rule, at the rail's scale.
 *
 * It sits at `right: -11px`, which with a 36px tile centred in a 58px column
 * lands its outer edge EXACTLY on the column's right edge: nothing overflows,
 * so the scroller needs no negative-margin trick to let it out, and the spine
 * reads as the column's own edge lighting up rather than as an object stuck to
 * the tile.
 *
 * The near-black/near-white bar follows `WorkRowShell`'s selection rule.
 */
export function RailSpine(): JSX.Element {
  return (
    <span
      data-testid="rail-spine"
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 right-[-11px] h-[20px] w-[3px] -translate-y-1/2 rounded-l-[2px] bg-text-strong"
    />
  )
}


export function RailHoverCard({
  anchor,
  title,
  meta,
  waiting,
}: {
  anchor: DOMRect
  title: string
  meta: string
  /** Is the status line an ASK? Then it wears the attention ochre, exactly as
   *  the wide row's second line does — one colour rule across both columns. */
  waiting: boolean
}): JSX.Element {
  // Clamped only against the viewport's own edges. The card is ~46px tall and
  // the column's list is inset by a header and a footer, so this fires
  // essentially never — but a tile scrolled flush to the top edge should not
  // hang the card off the window.
  const centre = Math.min(
    Math.max(anchor.top + anchor.height / 2, 40),
    Math.max(40, window.innerHeight - 40),
  )
  return createPortal(
    <div
      data-testid="rail-hover-card"
      role="tooltip"
      className={cn(
        MENU_HOVER_CARD,
        'pointer-events-none fixed z-[70] flex -translate-y-1/2 flex-col gap-[5px] whitespace-nowrap',
      )}
      style={{ left: anchor.right + 11, top: centre }}
    >
      <span className="text-[12px] leading-none tracking-[-.005em] text-text-strong">{title}</span>
      <span
        className={cn(
          'font-mono shell-type-micro leading-none',
          waiting ? 'text-attention' : 'text-text-dim',
        )}
      >
        {meta}
      </span>
    </div>,
    document.body,
  )
}

export function SidebarRail(): JSX.Element {
  return <PoolSidebarRail />
}
