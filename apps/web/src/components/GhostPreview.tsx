/**
 * GHOST PREVIEW — the shape of what is coming (POD-1058).
 *
 * An empty surface draws a dimmed, dead copy of its OWN real content, fading
 * out downward, with one line of live copy on top. It is not a skeleton: the
 * shapes are the same, the meaning is the opposite. A skeleton says *wait*; a
 * ghost preview says *this is what will be here*. Everything that could blur
 * that line is refused — see `.ghost-fade` in styles.css for the two rules
 * (never animate, always fade out) and why they live in CSS rather than at the
 * call sites.
 *
 * WHY A SHARED PRIMITIVE AND NOT FOUR LOCAL COPIES. Four surfaces ghost
 * themselves — the work list its rows, the flight deck its tree, the task
 * explorer its rows, the tab strip its tabs — and the thing they must agree on
 * is the RAMP. Four independently-tuned sets of greys is how one of them ends
 * up reading as loading while the other three read as a hint, and the ramp is
 * also the part that has to survive a theme swap in both directions.
 *
 * WHAT IS DELIBERATELY NOT HERE: the shapes. Each ghost mirrors the component
 * it stands in, so its geometry belongs beside that component's real geometry
 * — a row height, a rail inset, a tab pill — where a change to the live thing
 * is in the same file as the dead one.
 */
import type { CSSProperties, JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The four greys, brightest first.
 *
 * Tiers are how a ghost block recedes: uniform bars look broken, so rows step
 * DOWN the ramp as they go down the surface and the fade finishes the job. The
 * values are `--ghost-1..4` (index.css), mixes over transparent so the same
 * four tiers work over the work list, the deck and the dock without retuning.
 */
export type GhostTier = 1 | 2 | 3 | 4

const TIER_BG: Record<GhostTier, string> = {
  1: 'bg-(--ghost-1)',
  2: 'bg-(--ghost-2)',
  3: 'bg-(--ghost-3)',
  4: 'bg-(--ghost-4)',
}

/**
 * The wrapper every ghost block goes in: aria-hidden, inert, and masked.
 *
 * A11y is the whole reason this is a component rather than a class. The ghost
 * is DECORATION — it gets `aria-hidden`, it holds no focusable children, and it
 * never wears `role="img"` or an "loading" label, because announcing bars as
 * loading is the screen-reader version of the shimmer this pattern refuses.
 */
export function GhostPreview({
  children,
  className,
  /** How far down the block stays at full strength. Default 34%. */
  hold,
  /** Where the fade reaches zero. Default 100%; a block that runs to the bottom
   *  of a tall column wants it in a little (92–94%) so the last row is already
   *  gone before the column edge. */
  fadeTo,
  style,
  testId,
}: {
  children: ReactNode
  className?: string
  hold?: string
  fadeTo?: string
  style?: CSSProperties
  testId?: string
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className={cn('ghost-fade pointer-events-none select-none', className)}
      style={
        {
          ...(hold ? { '--ghost-hold': hold } : {}),
          ...(fadeTo ? { '--ghost-end': fadeTo } : {}),
          ...style,
        } as CSSProperties
      }
    >
      {children}
    </div>
  )
}

/**
 * One dead line of text.
 *
 * Bars, never lorem: invented titles are read as real data for exactly as long
 * as it takes to try clicking one. Widths are passed per bar and varied on
 * purpose — a column of identical bars reads as a rendering fault.
 */
export function GhostBar({
  tier = 2,
  width,
  height = 8,
  className,
}: {
  tier?: GhostTier
  /** Any CSS length. Percentages are the usual case — they keep a ghost row
   *  looking like a title in a column of any width. */
  width?: string
  height?: number
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn('block rounded-[4px]', TIER_BG[tier], className)}
      style={{ width, height }}
    />
  )
}

/** The dead ID square — a row's colour chip with no colour, at the same 3px
 *  radius the live `IdSquare` wears. */
export function GhostSquare({
  tier = 2,
  size = 10,
  className,
}: {
  tier?: GhostTier
  size?: number
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn('block flex-none rounded-[3px]', TIER_BG[tier], className)}
      style={{ width: size, height: size }}
    />
  )
}

/** A dead status dot. The ONE place a ghost is allowed a hue: the deck's
 *  session dots are what say "this pane is a status readout", and they take the
 *  semantic status colours at a ghost's opacity — never an issue colour, the
 *  same rule the live rows follow. */
export function GhostDot({
  tone,
  size = 7,
  className,
}: {
  /** A CSS colour — pass a semantic token (`var(--success)`), not a hex. */
  tone: string
  size?: number
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn('block flex-none rounded-full opacity-40', className)}
      style={{ width: size, height: size, background: tone }}
    />
  )
}
