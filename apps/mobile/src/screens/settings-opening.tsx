import type { MobxPool } from '@podium/client-graph'
import { useOpeningView } from '@podium/client-graph/react'
import { createSettingsViews } from '@podium/client-graph/settings-views'
import { createContext, type ReactNode, useContext } from 'react'
import { useMobilePool } from '../client/mobile-pool'
import { MachineUpdateReasons, useMachineUpdateReasons } from './machine-update-reasons'
import { createSettingsMachineReaders } from './settings-machine-readers'

export function createMobileSettingsView(pool: MobxPool) {
  const targetReasons = new MachineUpdateReasons()
  const settings = createSettingsViews(pool),
    machines = createSettingsMachineReaders(pool, () => targetReasons.answer)
  return {
    settings,
    machines,
    targetReasons,
    dispose() {
      targetReasons.close()
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
  useMachineUpdateReasons(view?.targetReasons ?? null)
  return <SettingsOpeningContext.Provider value={view}>{children}</SettingsOpeningContext.Provider>
}
export function useSettingsOpening() {
  return useContext(SettingsOpeningContext)
}
