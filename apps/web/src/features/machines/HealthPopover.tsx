import { Popover } from '@base-ui/react/popover'
import type { JSX, ReactElement, ReactNode } from 'react'
import { cloneElement, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * The topbar health-chip popover shell (quota + machine load): hover opens a
 * read-only preview anchored under the chip. Machine load can still pin that
 * panel on click (stays up, grows the breakdown) until Esc / outside click.
 * Quota does not — `pinOnClick={false}` keeps one hover tier, no second zoom.
 */
export function HealthPopover({
  trigger,
  children,
  pinnedWide = true,
  pinOnClick = true,
}: {
  /** The chip button; rendered as the popover trigger. Its props are widened so
   *  the shell can stamp the `data-pinned` flag onto it (see below). */
  trigger: ReactElement<Record<string, unknown>>
  /** Panel content, told whether the panel is pinned (clicked) or hover-only. */
  children: (pinned: boolean) => ReactNode
  /** Widen the panel from 296px to 336px once pinned. */
  pinnedWide?: boolean
  /** When false, click toggles the same hover panel and never pins it. */
  pinOnClick?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // A click on the chip means "pin the breakdown" only when this shell
        // offers a second zoom. Quota's hover panel is the whole story.
        if (pinOnClick && details.reason === 'trigger-press') {
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
      {/* Base UI marks the trigger `data-popup-open` for the hover preview too,
          so the chip needs its own flag to render pinned as a distinct rung —
          otherwise a panel you clicked open looks exactly like one you merely
          pointed at, and nothing on screen says which. */}
      <Popover.Trigger
        render={cloneElement(trigger, { 'data-pinned': pinned ? '' : undefined })}
        openOnHover
        delay={80}
      />
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
