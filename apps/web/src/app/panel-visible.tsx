/**
 * Whether the deck is showing this subtree. Warm session panels stay mounted
 * under `display:none`, so their descendants need an explicit signal to pause
 * periodic work. The default keeps clocks outside the deck unchanged.
 */
import { createContext, type JSX, type ReactNode, useContext } from 'react'

const PanelVisibleContext = createContext(true)

export function PanelVisible({
  visible,
  children,
}: {
  visible: boolean
  children: ReactNode
}): JSX.Element {
  return <PanelVisibleContext.Provider value={visible}>{children}</PanelVisibleContext.Provider>
}

/** True unless the caller is inside a deck panel the operator cannot see. */
export function usePanelVisible(): boolean {
  return useContext(PanelVisibleContext)
}
