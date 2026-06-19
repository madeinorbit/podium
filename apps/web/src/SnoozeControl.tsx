import type { SessionMeta } from '@podium/protocol'
import { AlarmClock, AlarmClockOff } from 'lucide-react'
import { type JSX, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isSnoozed, snoozeUntil1h, snoozeUntilTomorrow5am } from './derive'
import { useStore } from './store'
import { useNow } from './useNow'

const COARSE_POINTER =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(hover: none)').matches
    : false

/** Snooze toggle + hover menu. Direct click (mouse) → snooze until next message
 *  (or un-snooze). Hover → "Snooze for" menu. Touch tap → open the menu. */
export function SnoozeControl({
  session,
  className,
  iconSize = 13,
}: {
  session: SessionMeta
  className?: string
  iconSize?: number
}): JSX.Element {
  const { setSnooze, clearSnooze } = useStore()
  const now = useNow(60_000)
  const snoozed = isSnoozed(session, now)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuId = useId()
  const id = session.sessionId

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const openMenu = () => {
    if (COARSE_POINTER) return // touch opens via click, not hover
    cancelClose()
    setOpen(true)
  }
  const scheduleClose = () => {
    if (COARSE_POINTER) return
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 140)
  }
  const choose = (fn: () => void) => {
    fn()
    cancelClose()
    setOpen(false)
  }
  const onTrigger = () => {
    if (COARSE_POINTER) {
      setOpen((o) => !o)
      return
    }
    // Mouse: the menu is already hover-open; a click does the default action.
    if (snoozed) void clearSnooze(id)
    else void setSnooze(id, null)
    setOpen(false)
  }

  const wakeLabel = snoozed
    ? session.snoozedUntil
      ? `Snoozed until ${new Date(session.snoozedUntil).toLocaleString()} — click to un-snooze`
      : 'Snoozed until next message — click to un-snooze'
    : 'Snooze'

  return (
    <div className="relative inline-flex" onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-pressed={snoozed}
        title={wakeLabel}
        className={cn(
          'w-7 min-w-7 flex-none rounded-none',
          snoozed ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground',
          className,
        )}
        onClick={onTrigger}
      >
        {snoozed ? (
          <AlarmClockOff size={iconSize} aria-hidden="true" />
        ) : (
          <AlarmClock size={iconSize} aria-hidden="true" />
        )}
      </Button>
      {open && (
        <>
          {COARSE_POINTER && (
            <div
              className="fixed inset-0 z-40"
              aria-hidden="true"
              onClick={() => setOpen(false)}
            />
          )}
          <div
            id={menuId}
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-[150px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
          >
          <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">Snooze for</div>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => choose(() => void setSnooze(id, snoozeUntil1h(Date.now())))}
          >
            1 hour
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => choose(() => void setSnooze(id, snoozeUntilTomorrow5am(Date.now())))}
          >
            Until tomorrow
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => choose(() => void setSnooze(id, null))}
          >
            Until next message
          </button>
          {snoozed && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => choose(() => void clearSnooze(id))}
            >
              Un-snooze
            </button>
          )}
          </div>
        </>
      )}
    </div>
  )
}
