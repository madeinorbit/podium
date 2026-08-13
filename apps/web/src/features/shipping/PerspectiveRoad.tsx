import type { LucideIcon, LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

/** Lucide-compatible road-in-perspective glyph from the approved Shipping
 * prototype. Kept local until Lucide ships an equivalent named icon. */
export const PerspectiveRoad = forwardRef<SVGSVGElement, LucideProps>(function PerspectiveRoad(
  { color = 'currentColor', size = 24, strokeWidth = 2, absoluteStrokeWidth, ...props },
  ref,
) {
  const width = absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : strokeWidth
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M10 3 4 21" />
      <path d="m14 3 6 18" />
      <path d="M12 5v3" />
      <path d="M12 12v4" />
      <path d="M12 20v1" />
    </svg>
  )
}) as LucideIcon
