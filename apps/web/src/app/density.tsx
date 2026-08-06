import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useLayoutEffect, useState } from 'react'

export type ShellDensity = 'balanced' | 'compact'

/** Device-local because density follows the screen and the person using it. */
export const SHELL_DENSITY_KEY = 'podium.shell.density'

export function readStoredDensity(): ShellDensity {
  try {
    return localStorage.getItem(SHELL_DENSITY_KEY) === 'compact' ? 'compact' : 'balanced'
  } catch {
    return 'balanced'
  }
}

export function applyDensity(density: ShellDensity, root: HTMLElement): void {
  root.dataset.density = density
}

interface DensityContextValue {
  density: ShellDensity
  setDensity: (density: ShellDensity) => void
}

const DensityContext = createContext<DensityContextValue | null>(null)

export function DensityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [density, setDensityState] = useState<ShellDensity>(readStoredDensity)

  useLayoutEffect(() => {
    applyDensity(density, document.documentElement)
    try {
      localStorage.setItem(SHELL_DENSITY_KEY, density)
    } catch {
      // Storage can be unavailable in hardened/private webviews. The live
      // preference still applies for this app session.
    }
  }, [density])

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
