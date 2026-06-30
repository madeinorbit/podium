import type { SessionMeta } from '@podium/protocol'
import { AlarmClock, AlarmClockOff } from 'lucide-react'
import { type JSX, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isSnoozed, snoozeUntil1h, snoozeUntilTomorrow5am } from './derive'
import { useStore } from './store'
import { useNow } from './useNow'

const COARSE_POINTER =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(hover: none)').matches
    : false

// A single shared "which snooze menu is open" so only ONE menu is ever open
// across the whole sidebar. Hovering a different row's icon takes ownership and
// the previous menu unmounts at once — no stacked menus, no jumping between rows.
let activeMenu: string | null = null
const menuListeners = new Set<() => void>()
function setActiveMenu(key: string | null): void {
  if (activeMenu === key) return
  activeMenu = key
  for (const l of menuListeners) l()
}
function useIsActiveMenu(key: string): boolean {
  const active = useSyncExternalStore(
    (cb) => {
      menuListeners.add(cb)
      return () => menuListeners.delete(cb)
    },
    () => activeMenu,
    () => activeMenu,
  )
  return active === key
}

interface MenuPos {
  top: number
  right: number
  /** Icon height — the bridge that closes the icon→menu hover gap spans it. */
  height: number
}

/** Snooze toggle + hover menu. Direct click (mouse) → snooze until next message
 *  (or un-snooze). Hover → "Snooze for" menu, portalled under the icon. Touch tap
 *  → open the menu. Only one menu is open at a time (shared owner). */
export function SnoozeControl({
  session,
  className,
  iconSize = 13,
  dimmed = true,
}: {
  session: SessionMeta
  className?: string
  iconSize?: number
  /** When true (sidebar), the un-snoozed icon is muted; the open-session toolbar
   *  passes false so it reads as a normal, full-strength control. */
  dimmed?: boolean
}): JSX.Element {
  const { setSnooze, clearSnooze } = useStore()
  const now = useNow(60_000)
  const snoozed = isSnoozed(session, now)
  const menuKey = useId()
  const open = useIsActiveMenu(menuKey)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuId = useId()
  const id = session.sessionId

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const close = () => {
    cancelClose()
    if (activeMenu === menuKey) setActiveMenu(null)
  }
  // Anchor the menu to the LEFT of the icon (its right edge just left of the
  // icon), top-aligned. The snooze icons form a vertical column at the sidebar's
  // right edge, so reaching a menu that opens *downward* means crossing the next
  // row's icon (which steals the hover). Opening leftward means the pointer
  // travels away from that column — no sibling trigger sits in the path. Fixed
  // positioning + a portal escapes the sidebar's `overflow-y-auto` clip.
  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.top, right: Math.max(8, window.innerWidth - r.left + 4), height: r.height })
  }
  const openMenu = () => {
    if (COARSE_POINTER) return // touch opens on tap, not hover
    cancelClose()
    place()
    setActiveMenu(menuKey)
  }
  const scheduleClose = () => {
    if (COARSE_POINTER) return
    cancelClose()
    closeTimer.current = setTimeout(close, 140)
  }
  const choose = (fn: () => void) => {
    fn()
    close()
  }
  const onTrigger = () => {
    if (COARSE_POINTER) {
      if (open) close()
      else {
        place()
        setActiveMenu(menuKey)
      }
      return
    }
    // Mouse: the menu is already hover-open; a click does the default action.
    if (snoozed) void clearSnooze(id)
    else void setSnooze(id, null)
    close()
  }

  // A fixed-positioned menu would detach if the sidebar scrolled under it, so
  // close on any scroll/resize while open. (Picking an item or leaving also closes.)
  useEffect(() => {
    if (!open) return
    const dismiss = () => close()
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
    // close/menuKey are stable for this instance; re-run only when open flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const wakeLabel = snoozed
    ? session.snoozedUntil
      ? `Snoozed until ${new Date(session.snoozedUntil).toLocaleString()} — click to un-snooze`
      : 'Snoozed until next message — click to un-snooze'
    : 'Snooze'

  const item =
    'flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground'

  return (
    <span className="inline-flex" onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
      <Button
        ref={triggerRef}
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
          snoozed
            ? 'text-primary'
            : dimmed
              ? 'text-muted-foreground/70 hover:text-foreground'
              : 'text-foreground hover:text-foreground',
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
      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            {COARSE_POINTER && (
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                className="fixed inset-0 z-40 cursor-default"
                onClick={close}
              />
            )}
            {/* Invisible hover bridge spanning the small gap between the icon and the
                menu's right edge. Without it a slow pointer crossing the gap lands on
                the row beneath (which would steal hover / close the menu mid-travel).
                It keeps the menu open AND intercepts the row's pointer events. Mouse
                only — touch opens via tap and uses the full-screen backdrop above. */}
            {!COARSE_POINTER && (
              <div
                aria-hidden="true"
                className="fixed z-40"
                style={{ top: pos.top, height: pos.height, right: pos.right - 4, width: 8 }}
                onMouseEnter={openMenu}
                onMouseLeave={scheduleClose}
              />
            )}
            <div
              id={menuId}
              role="menu"
              className="fixed z-50 min-w-[160px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
              style={{ top: pos.top, right: pos.right }}
              onMouseEnter={openMenu}
              onMouseLeave={scheduleClose}
            >
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Snooze for</div>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => choose(() => void setSnooze(id, snoozeUntil1h(Date.now())))}
              >
                1 hour
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => choose(() => void setSnooze(id, snoozeUntilTomorrow5am(Date.now())))}
              >
                Until tomorrow
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => choose(() => void setSnooze(id, null))}
              >
                Until next message
              </button>
              {snoozed && (
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  onClick={() => choose(() => void clearSnooze(id))}
                >
                  Un-snooze
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
    </span>
  )
}
