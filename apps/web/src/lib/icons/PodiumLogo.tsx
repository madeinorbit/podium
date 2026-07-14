import type { JSX } from 'react'
import logoUrl from './podium-logo.svg'

/**
 * The Podium wordmark (.design/podium-logo.svg — white #f3f3f8 fill, baked into
 * the asset). The handoff renders it ~15px tall in the 44px top bar.
 */
export function PodiumLogo({
  height = 15,
  className,
}: {
  height?: number
  className?: string
}): JSX.Element {
  return <img src={logoUrl} height={height} alt="Podium" className={className} draggable={false} />
}
