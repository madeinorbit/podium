import { Popover } from '@base-ui/react/popover'
import type { JSX, ReactElement, ReactNode } from 'react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * The topbar health-chip popover shell (quota + machine load): hover opens a
 * read-only preview anchored under the chip; clicking the chip PINS the same
 * panel — it stays up, grows the full breakdown, and becomes interactive —
 * until Esc / outside click. One anatomy at two zoom levels instead of a text
 * tooltip plus a centered modal, so the board stays visible behind it.
 */
export function HealthPopover({
  trigger,
  children,
  pinnedWide = true,
}: {
  /** The chip button; rendered as the popover trigger. */
  trigger: ReactElement
  /** Panel content, told whether the panel is pinned (clicked) or hover-only. */
  children: (pinned: boolean) => ReactNode
  /** Widen the panel from 296px to 336px once pinned. */
  pinnedWide?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // A click on the chip always means "pin the breakdown": when the panel
        // is already hover-open, Base UI would toggle it closed — swallow that
        // and pin instead. A click while closed opens straight into pinned.
        if (details.reason === 'trigger-press') {
          setPinned(true)
          setOpen(true)
          return
        }
        // Hovering away must not dismiss a pinned panel.
        if (!next && pinned && details.reason === 'trigger-hover') return
        setOpen(next)
        if (!next) setPinned(false)
      }}
    >
      <Popover.Trigger render={trigger} openOnHover delay={80} />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            className={cn('health-popover', pinned && pinnedWide && 'health-popover-pinned')}
          >
            {children(pinned)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Micro mono footer; the hover tier's only chrome ("click to pin breakdown"). */
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
