import { QRCodeSVG } from 'qrcode.react'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/**
 * The code itself, on its own white plate.
 *
 * The plate is unconditional rather than themed: a QR is read by a camera, not
 * by the operator, and inverting it on a dark shell costs scan reliability on
 * every phone that assumes dark-on-light. Same treatment, same reason, as the
 * pairing code in Settings → Connected devices.
 */
export function MobileHandoffQr({
  url,
  size,
  className,
}: {
  url: string
  /** Module size in px; the plate adds its own padding around it. */
  size: number
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'flex flex-none items-center justify-center rounded-md bg-white p-1 ring-1 ring-black/10',
        className,
      )}
    >
      <QRCodeSVG
        value={url}
        size={size}
        level="M"
        marginSize={0}
        bgColor="#ffffff"
        fgColor="#16171a"
        aria-hidden="true"
      />
    </span>
  )
}

/** `host/mobile` — what the code resolves to, short enough for a 300px sheet. */
export function mobileHandoffLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}
