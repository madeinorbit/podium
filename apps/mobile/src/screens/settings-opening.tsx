import { createSettingsViews } from '@podium/client-graph/settings-views'
import type { MobxPool } from '@podium/client-graph'
import { useOpeningView } from '@podium/client-graph/react'
import { createContext, useContext, type ReactNode } from 'react'
import { useMobilePool } from '../client/mobile-pool'
import { createSettingsMachineReaders } from './settings-machine-readers'

export function createMobileSettingsView(pool: MobxPool) {
  const settings = createSettingsViews(pool),
    machines = createSettingsMachineReaders(pool)
  return {
    settings,
    machines,
    dispose() {
      settings.dispose()
      machines.dispose()
    },
  }
}
const SettingsOpeningContext = createContext<ReturnType<typeof createMobileSettingsView> | null>(
  null,
)
export function SettingsOpening({ children }: { children: ReactNode }) {
  const pool = useMobilePool()
  const view = useOpeningView(pool, createMobileSettingsView)
  return <SettingsOpeningContext.Provider value={view}>{children}</SettingsOpeningContext.Provider>
}
export function useSettingsOpening() {
  return useContext(SettingsOpeningContext)
}
