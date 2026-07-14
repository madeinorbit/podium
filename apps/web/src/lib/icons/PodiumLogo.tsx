import type { JSX } from 'react'
import logoUrl from './podium-logo.svg'

/** width/height of the SVG viewBox (290.9 225.3 826.4 317.7) — the asset has no
 *  width/height attributes, so browsers see no intrinsic size, only this ratio. */
const LOGO_ASPECT = 826.4 / 317.7

/**
 * The Podium wordmark (.design/podium-logo.svg — white #f3f3f8 fill, baked into
 * the asset). The handoff renders it ~15px tall in the 44px top bar.
 *
 * Sized via inline CSS, not the height attribute: Tailwind preflight's
 * `img { max-width: 100%; height: auto }` outranks presentational attributes,
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
    <img
      src={logoUrl}
      alt="Podium"
      className={className}
      draggable={false}
      style={{ height, width: Math.round(height * LOGO_ASPECT * 100) / 100, maxWidth: 'none' }}
    />
  )
}
