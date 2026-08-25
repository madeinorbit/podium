import type { ComponentType, JSX } from 'react'
import { lazy, Suspense } from 'react'
import { useThemeAppearance } from '@/app/theme'
import type { ShellGlyphName } from './MaterialSymbols'

/**
 * THE GLYPH TABLE IS DEFERRED, AND THIS IS WHY IT HAS TO BE.
 *
 * `MaterialSymbols.tsx` is ~28KB of path data for an appearance that is off by
 * default and offered on one platform. Imported statically it would sit in the
 * eager graph of every session that will never turn the profile on — the exact
 * cost `DEFERRED_FIRST_PAINT_MODULES` in scripts/web-bundle-budget.ts exists to
 * keep out, and that list names this module so it cannot come back by accident.
 *
 * The fallback is the LUCIDE ICON at the same size, so nothing moves while the
 * chunk resolves: same box, same ink, one frame of the other family at worst.
 * `preloadShellGlyphs()` below removes even that frame for the case that matters
 * — a cold boot with the profile already on.
 *
 * The `ShellGlyphName` import is type-only and erased, so a call site naming a
 * glyph does not pull the table in with it.
 */
const MaterialSymbol = lazy(() =>
  import('./MaterialSymbols').then((module) => ({ default: module.MaterialSymbol })),
)

/**
 * Start fetching the glyph table now.
 *
 * Called from the entry point when the pre-React appearance is already Omarchy
 * (app/main.tsx), so the chunk is in flight before React's first render rather
 * than after it. Fire-and-forget: a failure here is a Suspense fallback showing
 * a lucide glyph, not a broken shell, and `lazy` will retry on demand.
 */
export function preloadShellGlyphs(): void {
  void import('./MaterialSymbols').catch(() => {})
}

/**
 * ONE CHROME GLYPH, IN WHICHEVER FAMILY THE APPEARANCE DRAWS [POD-1531].
 *
 * The Podium appearance draws its shell in lucide; the Omarchy design draws the
 * same shell in Material Symbols Rounded. Those are two families, not two
 * weights of one, so the swap has to happen per glyph rather than in a token —
 * and it has to happen at the call site, because only the call site knows which
 * Material glyph the design named for that particular control.
 *
 * WHY BOTH ARE NAMED HERE rather than mapping lucide → Material in a table: the
 * mapping is not a function of the lucide icon. `ChevronDown` is `expand_more`
 * on a disclosure and nothing at all on a select caret the design never draws,
 * and `Archive` is `inventory_2` in the work list only. A table would have to
 * guess; a prop pair states what the artboard actually says.
 *
 * Off the Omarchy profile this is exactly `<Icon size={size} />` — same element,
 * same props, no wrapper, no Suspense. Generic Linux renders what it rendered
 * before.
 */
export function ShellGlyph({
  icon: Icon,
  glyph,
  size = 16,
  strokeWidth,
  className,
  ...props
}: {
  /** What the Podium appearance draws — the lucide component the call site used. */
  icon: ComponentType<{
    size?: number
    strokeWidth?: number
    className?: string
    'aria-hidden'?: boolean
  }>
  /** What the Omarchy design names for this control. */
  glyph: ShellGlyphName
  size?: number
  /** The lucide stroke the call site already chose. Passed straight through, and
   *  meaningless to a Material Symbol, which is a filled path at a fixed weight —
   *  dropping it there rather than forwarding it is what keeps the Podium
   *  appearance's own line weights exactly where they were. */
  strokeWidth?: number
  className?: string
  'aria-hidden'?: boolean
}): JSX.Element {
  const appearance = useThemeAppearance()
  const fallback = <Icon size={size} strokeWidth={strokeWidth} className={className} {...props} />
  if (appearance !== 'omarchy') return fallback
  return (
    <Suspense fallback={fallback}>
      <MaterialSymbol name={glyph} size={size} className={className} {...props} />
    </Suspense>
  )
}
