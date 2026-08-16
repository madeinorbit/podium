/**
 * The update surface's context, on its own, with no provider attached.
 *
 * SPLIT FROM THE PROVIDER ON PURPOSE. The provider registers the service worker
 * and therefore imports `virtual:pwa-register/react` — a Vite virtual module
 * that only exists when the PWA plugin is in the pipeline. The status strip
 * only wants to READ this context, and pulling the whole provider into its
 * module graph would make an unrelated component's tests depend on the build's
 * PWA plugin. Consumers import this; only the composition root imports the
 * provider.
 */
import { createContext, useContext } from 'react'
import type { IndicatorState } from './operation-view'

export interface UpdatesContextValue {
  indicator: IndicatorState
  indicatorLabel: string
  /** Whether the panel is currently expanded — the indicator's `aria-expanded`. */
  open: boolean
  toggle: () => void
  show: () => void
  checkNow: () => void
}

/**
 * The default is a REAL, INERT value rather than `undefined`: a component that
 * renders outside the provider (a test, a screen mounted before the shell) must
 * degrade to "there is no update" instead of throwing.
 */
export const UpdatesContext = createContext<UpdatesContextValue>({
  indicator: 'none',
  indicatorLabel: '',
  open: false,
  toggle: () => {},
  show: () => {},
  checkNow: () => {},
})

export function useUpdates(): UpdatesContextValue {
  return useContext(UpdatesContext)
}
