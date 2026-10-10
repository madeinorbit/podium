import { RecordRequest } from '@podium/client-graph/requested-records'
import { createSettingsViews } from '@podium/client-graph/settings-views'
import type { MobxPool } from '@podium/client-graph'
import { useOpeningView } from '@podium/client-graph/react'
import type { ReactNode } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { SettingsOpeningContext } from './opening-context'
import { createSettingsMachineReaders } from './settings-machine-readers'

export function createWebSettingsView(pool: MobxPool) {
  const settings = createSettingsViews(pool)
  const accounts = new RecordRequest(pool, 'account', row => row.id)
  const machines = createSettingsMachineReaders(pool)
  return {
    settings,
    accounts,
    machines,
    dispose() {
      settings.dispose()
      accounts.dispose()
      machines.dispose()
    },
  }
}

export function SettingsOpening({ children }: { children: ReactNode }) {
  const view = useOpeningView(useWorklistPool(), createWebSettingsView)
  return <SettingsOpeningContext.Provider value={view}>{children}</SettingsOpeningContext.Provider>
}
