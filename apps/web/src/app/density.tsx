import {
  readStoredDensity,
  SHELL_DENSITY_KEY,
  type ShellDensity,
  type UiState,
} from '@podium/client-core/ui-state'
import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useLayoutEffect, useState } from 'react'

export { readStoredDensity, SHELL_DENSITY_KEY, type ShellDensity }

export function applyDensity(density: ShellDensity, root: HTMLElement): void {
  root.dataset.density = density
}

/** Compact styling is experimental. Keep the stored preference dormant while
 *  the gate is off so re-enabling it restores the user's previous choice. */
export function resolveDensity(preferred: ShellDensity, densityEnabled: boolean): ShellDensity {
  return densityEnabled ? preferred : 'balanced'
}

interface DensityContextValue {
  density: ShellDensity
  setDensity: (density: ShellDensity) => void
}

const DensityContext = createContext<DensityContextValue | null>(null)

export function DensityProvider({
  children,
  uiState,
  densityEnabled,
}: {
  children: ReactNode
  uiState: Pick<UiState, 'get' | 'set'>
  densityEnabled: boolean
}): JSX.Element {
  const [preferredDensity, setDensityState] = useState<ShellDensity>(() => readStoredDensity(uiState))
  const density = resolveDensity(preferredDensity, densityEnabled)

  useLayoutEffect(() => {
    applyDensity(density, document.documentElement)
    if (densityEnabled) uiState.set(SHELL_DENSITY_KEY, preferredDensity)
  }, [density, densityEnabled, preferredDensity, uiState])

  return (
    <DensityContext.Provider value={{ density, setDensity: setDensityState }}>
      {children}
    </DensityContext.Provider>
  )
}

export function useDensity(): DensityContextValue {
  const value = useContext(DensityContext)
  if (!value) throw new Error('useDensity outside DensityProvider')
  return value
}
