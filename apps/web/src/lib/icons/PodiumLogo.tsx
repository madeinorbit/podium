import type { JSX } from 'react'
import { cn } from '@/lib/utils'
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
  return (
    <span
      role="img"
      aria-label="Podium"
      className={cn('block bg-current text-text-strong', className)}
      style={{
        height,
        width: Math.round(height * LOGO_ASPECT * 100) / 100,
        maxWidth: 'none',
        maskImage: `url(${logoUrl})`,
        WebkitMaskImage: `url(${logoUrl})`,
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
