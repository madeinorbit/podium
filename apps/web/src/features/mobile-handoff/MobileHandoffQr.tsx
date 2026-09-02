import { QRCodeSVG } from 'qrcode.react'
import type { JSX } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The code itself, on its own white plate.
 *
 * The plate is unconditional rather than themed: a QR is read by a camera, not
 * by the operator, and inverting it on a dark shell costs scan reliability on
 * every phone that assumes dark-on-light. Same treatment, same reason, as the
 * pairing code in Settings → Connected devices.
 *
 * THE ADDRESS LIVES ON THE CODE, not beside it. Printing `host/mobile` under
 * every code spent a line of both surfaces on a string nobody types — the
 * camera reads it. It is still the answer to "where does this send me?", so it
 * comes back on hover (and on focus: the plate is a tab stop, and its label
 * carries the address for anyone who never sees the tooltip).
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
  const label = mobileHandoffLabel(url)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // This is a focusable tooltip anchor, not a press action. Keeping it
          // outside the pressable motion contract avoids promising a click.
          <button
            type="button"
            data-pressable-exempt
            className={cn(
              'flex flex-none cursor-help items-center justify-center rounded-md border-0 bg-white p-1 ring-1 ring-black/10',
              className,
            )}
            aria-label={`Opens ${label}`}
            data-testid="mobile-handoff-qr"
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
          </button>
        }
      />
      {/* Above the plate and flush with its left edge, far enough out to clear
          the sheet's own head — a label ON the code, not a lid over the surface
          that holds it. */}
      <TooltipContent side="top" align="start" alignOffset={-4} sideOffset={10}>
        <span className="font-mono">{label}</span>
      </TooltipContent>
    </Tooltip>
  )
}

/** `host/mobile` — what the code resolves to, short enough for a tooltip. */
export function mobileHandoffLabel(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'podium:') return 'the current session in Podium'
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}
