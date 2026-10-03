/**
 * THE COLLAPSED SIDEBAR RAIL (#41, redrawn to design 3b — POD-1178).
 *
 * SPACING AND THE FOOTER PAIR (POD-1279). Every element in the column carries
 * 2px more air on each side than 3b drew — the gaps between tiles, the group
 * labels, and both chrome ends — because at 58px wide the column's only way to
 * separate one mark from the next is the space around it, and 3b's 4px gap had
 * the tiles reading as one striped block. The project label lost a rung with
 * it: it names the group the tiles under it belong to, and at the same size as
 * the shell's other micro labels it competed with the numbers it introduces.
 *
 * AND THE ⊞ MOVED DOWN. The rail's two spawn controls used to stack at the top
 * while the footer held a search glyph and a waiting TOTAL. The open column
 * puts add and search together in one strip at the BOTTOM, so the rail does
 * too — and the total went, because it was a readout in a strip of controls and
 * the tiles above already carry the same attention, one badge per mission,
 * where the click that answers it is.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY THE COLUMN GOT WIDER
 * ---------------------------------------------------------------------------
 *
 * 3a folded the wide list down to a 52px strip of 26px SQUARES: the same mark
 * the wide row wears, at the same size, with the row's text thrown away and
 * packed into a `title` attribute. It read as a list of stamps. Three facts the
 * operator collapses the sidebar to keep — which project a mission belongs to,
 * how far it has got, and what it is called — were either gone (the project was
 * a bare 1px hairline) or a second away behind an OS tooltip.
 *
 * 3b spends six more pixels of width, and buys all three back:
 *
 *   THE MARK IS A TILE, not a square. 36×32 with the number set alone at
 *   11.5px. The prefix is the same on every mark in the column, so dropping it
 *   is free, and what it frees is the one thing the strip had none of: room.
 *   `IdSquare` still draws it — geometry, tint, badge and colour picker all
 *   stay central (POD-1178 widened that component rather than forking it), so
 *   the rail cannot drift away from the square language it belongs to.
 *
 *   GROUPS ARE NAMED. The hairline said "a boundary is here"; the label says
 *   which project you are looking at, which is what the wide column says in the
 *   same place. It rides `label-mono` — the shell's 10.5px floor — not the
 *   mock's 8.5px, per POD-783: uppercase tracked mono is the hardest thing on
 *   the ramp to read small, and the floor exists precisely for this case.
 *
 *   PROGRESS IS ON THE MARK. `RailProgressMeter` insets the wide list's own
 *   meter into the foot of the tile — the only free surface a 58px column has.
 *
 *   THE TOOLTIP BECAME A CARD. Title on one line, the row's status phrase on
 *   the next in the motion grammar's own colours, opening instantly beside the
 *   tile instead of a second later on top of it. It is the menu surface
 *   (`MENU_HOVER_CARD`), because it opens from the same gesture one pixel off
 *   the same column as the colour picker and has to be the same object.
 *
 * AND THE SELECTION MARK MOVED. 3a grew a 10px gradient notch out of the square
 * and across the aside's border into the flight deck's column — a bridge, said
 * twice. 3b makes it the wide row's own 3px spine, flush with the column's
 * right edge: the same grammar in both states of the sidebar, and nothing to
 * paint across a border that the design no longer draws.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT NOW AGREES WITH THE WIDE LIST
 * ---------------------------------------------------------------------------
 *
 * The rail used to re-group `work` from scratch, which kept pinned missions
 * inside their project group where the wide column hoists them into a PINNED
 * section above everything. Two columns, two orders, one ⌘-digit — so ⌘3 could
 * name a different mission collapsed than expanded. 3b draws the pinned section
 * the design shows, which is the published split every other surface already
 * reads (`pinned` + `groups`), so the digits and both columns finally agree.
 *
 * The shell (#40) owns the 58px aside and the collapse flag; the ⟩ expand
 * control is its header band. This component fills everything under it.
 */

import type { MotionPhase } from '@podium/client-core/viewmodels'
import { type JSX, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import type { IdSquareBadge } from '@/components/IdSquare'
import { MENU_HOVER_CARD } from '@/lib/menu-surface'
import { cn } from '@/lib/utils'

const PoolSidebarRail = lazy(() =>
  import('./pool-sidebar-rail').then((m) => ({ default: m.PoolSidebarRail })),
)

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
 * NEUTRAL INK, not the issue hue — `WorkRowShell`'s rule, and the design draws
 * the same near-black/near-white bar: the tile beside it is already tinted with
 * the issue's colour, and selection is a different question from identity. A
 * hued spine also lost the argument on contrast, since an issue colour at 3px
 * against a tinted tile is a whisper in either theme.
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

/**
 * The hover card, portaled and fixed.
 *
 * It CANNOT live inside the tile's wrapper: the squares column scrolls, and an
 * `overflow-y: auto` box clips horizontally too, so a card reaching 200px to
 * the right would be cut off at the column's edge. Same reason — and the same
 * solution — as the colour picker two files over.
 *
 * `pointer-events-none`, so sweeping the mouse toward the card never lands the
 * cursor on the card itself and the tile underneath never loses its hover.
 */
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
  return (
    <Suspense fallback={null}>
      <PoolSidebarRail />
    </Suspense>
  )
}
