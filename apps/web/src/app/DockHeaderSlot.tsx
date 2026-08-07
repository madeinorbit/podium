import { createContext, type JSX, type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'

/**
 * The dock title bar is a panel's ONE header (POD-516 item 10).
 *
 * A panel that needs controls used to grow a second bar under the dock title —
 * which meant two names and two bands for one surface. Instead the dock title
 * bar lends its right side: a panel renders `<DockHeaderActions>` wherever its
 * state lives, and the buttons land beside the dock's own close control.
 *
 * The context carries the host element rather than a render prop so the actions
 * stay owned by (and re-render with) the panel that can actually run them.
 */
const DockHeaderSlotContext = createContext<HTMLElement | null>(null)

export const DockHeaderSlotProvider = DockHeaderSlotContext.Provider

/** Renders a panel's header actions into the dock title bar, or nothing at all
 *  when the panel is mounted outside a dock. */
export function DockHeaderActions({ children }: { children: ReactNode }): JSX.Element | null {
  const host = useContext(DockHeaderSlotContext)
  return host ? createPortal(children, host) : null
}
