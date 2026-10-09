import { createSettingsViews } from '@podium/client-graph/settings-views'
import type { MobxPool } from '@podium/client-graph'
import { useOpeningView } from '@podium/client-graph/react'
import type { ReactNode } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { SettingsOpeningContext } from './opening-context'
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

export function SettingsOpening({ children }: { children: ReactNode }) {
  const view = useOpeningView(useWorklistPool(), createWebSettingsView)
  return <SettingsOpeningContext.Provider value={view}>{children}</SettingsOpeningContext.Provider>
}
