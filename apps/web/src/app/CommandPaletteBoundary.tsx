import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useStoreSelector } from './store'

const CommandPalette = lazy(() =>
  import('./CommandPalette').then((module) => ({ default: module.CommandPalette })),
)

/**
 * Keep the palette out of the startup graph until its first open, then keep its
 * component mounted. The latter is lifecycle-significant: commands can close
 * the palette while a child flow (new task or repository scan) remains open.
 */
export function CommandPaletteBoundary(): JSX.Element | null {
  const paletteOpen = useStoreSelector((state) => state.paletteOpen)
  const [activated, setActivated] = useState(paletteOpen)

  useEffect(() => {
    if (paletteOpen) setActivated(true)
  }, [paletteOpen])

  if (!activated) return null
  return (
    <Suspense fallback={null}>
      <CommandPalette />
    </Suspense>
  )
}
