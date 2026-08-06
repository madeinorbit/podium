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

interface DensityContextValue {
  density: ShellDensity
  setDensity: (density: ShellDensity) => void
}

const DensityContext = createContext<DensityContextValue | null>(null)

export function DensityProvider({
  children,
  uiState,
}: {
  children: ReactNode
  uiState: Pick<UiState, 'get' | 'set'>
}): JSX.Element {
  const [density, setDensityState] = useState<ShellDensity>(() => readStoredDensity(uiState))

  useLayoutEffect(() => {
    applyDensity(density, document.documentElement)
    uiState.set(SHELL_DENSITY_KEY, density)
  }, [density, uiState])

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
