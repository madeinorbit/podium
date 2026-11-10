import {
  readStoredDensity,
  SHELL_DENSITY_KEY,
  type ShellDensity,
} from '@podium/client-core/ui-state'
import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useLayoutEffect } from 'react'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'

export { readStoredDensity, SHELL_DENSITY_KEY, type ShellDensity }

export function applyDensity(density: ShellDensity, root: HTMLElement): void {
  root.dataset.density = density
}

interface DensityContextValue {
  density: ShellDensity
  setDensity: (density: ShellDensity) => void
}

const DensityContext = createContext<DensityContextValue | null>(null)

const parseDensity = (raw: string | null): ShellDensity =>
  raw === 'compact' ? 'compact' : 'balanced'
const serializeDensity = (value: ShellDensity): string => value

export function DensityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [density, setDensity] = usePersistedUiState(
    SHELL_DENSITY_KEY,
    parseDensity,
    serializeDensity,
  )
  useLayoutEffect(() => applyDensity(density, document.documentElement), [density])
  return (
    <DensityContext.Provider value={{ density, setDensity }}>
      {children}
    </DensityContext.Provider>
  )
}

export function useDensity(): DensityContextValue {
  const value = useContext(DensityContext)
  if (!value) throw new Error('useDensity outside DensityProvider')
  return value
}
