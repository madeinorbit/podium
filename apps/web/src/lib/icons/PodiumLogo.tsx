import type { JSX } from 'react'
import { useThemeAppearance } from '@/app/theme'
import { cn } from '@/lib/utils'
import omarchyLogoUrl from './omarchy/om-wordmark.svg'
import logoUrl from './podium-logo.svg'

/** width/height of the SVG viewBox (290.9 225.3 826.4 317.7) — the asset has no
 *  width/height attributes, so browsers see no intrinsic size, only this ratio. */
const LOGO_ASPECT = 826.4 / 317.7

/**
 * The Podium wordmark (.design/podium-logo.svg). The handoff renders it ~15px
 * tall in the 44px top bar.
 *
 * Painted as a MASK over `currentColor`, not as an `<img>` (POD-388): the asset
 * bakes a white `#f3f3f8` fill, which is the wordmark's ink in the dark themes
 * and invisible on Daylight's paper. The mask keeps one asset and lets the ink
 * be a token — `text-text-strong` by default, overridable through `className`.
 *
 * Sized via inline CSS, not width/height attributes: Tailwind preflight's
 * `img { max-width: 100%; height: auto }` outranked presentational attributes,
 * and with them the viewBox-only SVG blew up to its fallback intrinsic box.
 */
export function PodiumLogo({
  height = 15,
  className,
}: {
  height?: number
  className?: string
}): JSX.Element {
  // The Omarchy design supplies its own wordmark file (`om-wordmark.svg`, the
  // same outline at the profile's #c0caf5). The mask discards a source's fill,
  // so both assets would paint identically — the swap is here because the
  // profile's mark should BE the file the design ships, not a look-alike that
  // happens to land on the same pixels. `text-text-strong` is #c0caf5 in this
  // appearance, which is that file's own ink.
  const appearance = useThemeAppearance()
  const src = appearance === 'omarchy' ? omarchyLogoUrl : logoUrl
  return (
    <span
      role="img"
      aria-label="Podium"
      className={cn('block bg-current text-text-strong', className)}
      style={{
        height,
        width: Math.round(height * LOGO_ASPECT * 100) / 100,
        maxWidth: 'none',
        maskImage: `url(${src})`,
        WebkitMaskImage: `url(${src})`,
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  )
}
