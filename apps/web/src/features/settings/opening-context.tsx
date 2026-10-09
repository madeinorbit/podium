import { createContext, useContext } from 'react'
import type { createWebSettingsView } from './SettingsOpening'

// Setup reads the context during startup. Keep the settings opening's factory
// in the settings screen's module so those readers do not load the whole view.
export const SettingsOpeningContext = createContext<ReturnType<typeof createWebSettingsView> | null>(null)
export function useSettingsOpening() {
  return useContext(SettingsOpeningContext)
}
