import { useCallback, useLayoutEffect, useState } from 'react'
import type { RightPanelTab } from './shell-state'

// CSS pixels: use the window's available space, not the display's resolution.
export const SIDEBARS_FOLD_BELOW = 1600
export const SIDEBARS_RESTORE_AT = 1680

interface WindowLayout {
  compact: boolean
  sidebarRevealed: boolean
  rightPanelRevealed: boolean
}

/** Automatic folds belong to this window; only explicit actions write preferences. */
export function useResponsiveSidebars({
  sidebarCollapsed: savedSidebarCollapsed,
  rightPanel: savedRightPanel,
  setSidebarCollapsed: saveSidebarCollapsed,
  setRightPanel: saveRightPanel,
}: {
  sidebarCollapsed: boolean
  rightPanel: RightPanelTab | null
  setSidebarCollapsed: (collapsed: boolean) => void
  setRightPanel: (panel: RightPanelTab | null) => void
}) {
  const [layout, setLayout] = useState<WindowLayout>(() => ({
    compact: typeof window !== 'undefined' && window.innerWidth < SIDEBARS_FOLD_BELOW,
    sidebarRevealed: false,
    rightPanelRevealed: false,
  }))

  useLayoutEffect(() => {
    const onResize = (): void => {
      const width = window.innerWidth
      setLayout((previous) => {
        const compact = width < (previous.compact ? SIDEBARS_RESTORE_AT : SIDEBARS_FOLD_BELOW)
        // Keep manual reveals throughout a compact visit, including small resizes.
        return compact === previous.compact
          ? previous
          : { compact, sidebarRevealed: false, rightPanelRevealed: false }
      })
    }
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const setSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      setLayout((previous) => ({ ...previous, sidebarRevealed: !collapsed }))
      saveSidebarCollapsed(collapsed)
    },
    [saveSidebarCollapsed],
  )
  const setRightPanel = useCallback(
    (panel: RightPanelTab | null) => {
      setLayout((previous) => ({ ...previous, rightPanelRevealed: panel !== null }))
      saveRightPanel(panel)
    },
    [saveRightPanel],
  )

  return {
    compact: layout.compact,
    sidebarCollapsed: savedSidebarCollapsed || (layout.compact && !layout.sidebarRevealed),
    rightPanel: layout.compact && !layout.rightPanelRevealed ? null : savedRightPanel,
    setSidebarCollapsed,
    setRightPanel,
  }
}
