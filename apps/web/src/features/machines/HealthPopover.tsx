import { Popover } from '@base-ui/react/popover'
import type { JSX, ReactElement, ReactNode } from 'react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * The topbar health-chip popover shell (quota + machine load): hover opens the
 * panel anchored under the chip, Esc or a click outside dismisses it.
 *
 * ONE TIER, NO PIN. Machine load used to offer a second zoom — click to pin the
 * panel open and grow the process breakdown into it. Quota never did
 * (`pinOnClick={false}` was already the flag that said so), and load has now
 * dropped it too: the panel shows everything it knows the moment it opens, so
 * there is no second state left to reach and nothing a click could reveal.
 */
export function HealthPopover({
  trigger,
  children,
  popupClassName,
}: {
  /** The chip button; rendered as the popover trigger. */
  trigger: ReactElement<Record<string, unknown>>
  /** Panel content. */
  children: ReactNode
  /** Feature-specific treatment for a panel whose design differs from the
   *  shared machine-health shell. */
  popupClassName?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} openOnHover delay={80} />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup className={cn('health-popover', popupClassName)}>{children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Micro mono footer; the panel's only chrome ("sampled 14:32:07", "esc closes"). */
export function HealthPopoverFooter({
  left,
  right,
}: {
  left: ReactNode
  right?: ReactNode
}): JSX.Element {
  return (
    <div className="hp-footer">
      <span>{left}</span>
      {right != null && <span>{right}</span>}
    </div>
  )
}
