import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * THE COMMAND BAR'S DYNAMIC CENTRE (POD-365).
 *
 * The top bar has four zones: mode tabs, this slot, the instrument well, and the
 * utilities. The slot belongs to whichever MODE is active — it is the toolbar's
 * only mode-dependent region, and the mechanism by which a mode gets a toolbar
 * without growing a bar of its own.
 *
 * WHAT MAY GO IN IT. A control earns the slot only when its scope is the whole
 * mode AND no column already owns it. Work fails the second test on every
 * candidate: starting an agent belongs to the sidebar's spawn row, adding a
 * session to the tab strip's "+", splitting to the glyph beside it, and branch
 * state to `GitStamp`'s four prescribed densities (POD-98). So Work renders
 * nothing here, and that is the correct answer rather than an omission — an
 * empty centre is evidence the workspace is well organised. Tasks passes on all
 * four of its controls, which is why it previously paid for them with two extra
 * full-bleed bars. Workflows, Automations and Specs may claim it on the same
 * test. See DESIGN.md §Navigation.
 *
 * WHY A PORTAL. The controls belong to their view — they close over its filter
 * state, its mutations, its dialogs — but they render two levels up. A portal
 * keeps ownership where the state is and moves only the pixels, so no view state
 * has to be lifted into the shell to put a button in the toolbar.
 */
const ToolbarSlotContext = createContext<{
  node: HTMLElement | null
  setNode: (node: HTMLElement | null) => void
  filled: boolean
  claim: () => () => void
}>({ node: null, setNode: () => {}, filled: false, claim: () => () => {} })

export function ToolbarSlotProvider({ children }: { children: ReactNode }): JSX.Element {
  const [node, setNode] = useState<HTMLElement | null>(null)
  // A count, not a boolean: during a mode switch the outgoing view unmounts
  // after the incoming one mounts, so a boolean would flicker the seam off.
  const [claims, setClaims] = useState(0)
  const value = useMemo(
    () => ({
      node,
      setNode,
      filled: claims > 0,
      claim: () => {
        setClaims((n) => n + 1)
        return () => setClaims((n) => n - 1)
      },
    }),
    [node, claims],
  )
  return <ToolbarSlotContext.Provider value={value}>{children}</ToolbarSlotContext.Provider>
}

/**
 * The slot's landing site, rendered by TopBar. `ref` runs before the consuming
 * view's effects, so a view mounted in the same commit still finds a node.
 */
export function ToolbarSlotTarget({ className }: { className?: string }): JSX.Element {
  const { setNode } = useContext(ToolbarSlotContext)
  return <div ref={setNode} className={className} data-testid="topbar-slot" />
}

/** Whether any mode is currently claiming the slot — drives the leading seam,
 *  which must not render as a divider pointing at an empty centre. */
export function useToolbarSlotFilled(): boolean {
  return useContext(ToolbarSlotContext).filled
}

/**
 * Render `children` into the command bar's centre. Renders nothing until the
 * target exists, so a view may mount before the bar without guarding.
 */
export function ToolbarSlot({ children }: { children: ReactNode }): JSX.Element | null {
  const { node, claim } = useContext(ToolbarSlotContext)
  useEffect(() => claim(), [claim])
  return node ? createPortal(children, node) : null
}
