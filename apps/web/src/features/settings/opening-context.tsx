import { createSettingsViews } from '@podium/client-graph/settings-views'
import type { MobxPool } from '@podium/client-graph'
import { useOpeningView } from '@podium/client-graph/react'
import { createContext, useContext, type ReactNode } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { createSettingsMachineReaders } from './settings-machine-readers'

export function createWebSettingsView(pool: MobxPool) {
  const settings = createSettingsViews(pool)
  const machines = createSettingsMachineReaders(pool)
  return {
    settings,
    machines,
    dispose() {
      settings.dispose()
      machines.dispose()
    },
  }
}
const SettingsOpeningContext = createContext<ReturnType<typeof createWebSettingsView> | null>(null)
export function SettingsOpening({ children }: { children: ReactNode }) {
  const pool = useWorklistPool()
  const view = useOpeningView(pool, createWebSettingsView)
  return <SettingsOpeningContext.Provider value={view}>{children}</SettingsOpeningContext.Provider>
}
export function useSettingsOpening() {
  return useContext(SettingsOpeningContext)
}
