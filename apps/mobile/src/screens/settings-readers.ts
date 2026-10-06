import { settingsView } from '@podium/client-graph/settings-views'
import type { MobxPool } from '@podium/client-graph'
import type { MobileSettingsDiagnostics } from '@podium/client-graph/mobile-settings'
import { visibleFleetOperations, type MachineOperationsView } from '@podium/client-core/values'
import { keyedComputed } from '@podium/mobx-helpers'
import { useCallback } from 'react'
import { useMobilePoolProjection } from '../client/mobile-pool'

export type SettingsMachineStatus = Pick<
  MachineOperationsView,
  'id' | 'name' | 'online' | 'statusLabel' | 'updateChannel' | 'updateLabel'
>
export interface SettingsData extends MobileSettingsDiagnostics {
  machineIds: readonly string[]
  machineCount: number
  fleetLabel: string
  updateLabel: string
  sessionCount: number
  outboxSize: number
  outboxDeadLetterCount: number
}
const EMPTY_IDS: readonly string[] = []
const EMPTY_SETTINGS: SettingsData = {
  machineIds: EMPTY_IDS,
  machineCount: 0,
  fleetLabel: 'No visible machines',
  updateLabel: 'No visible machines',
  sessionCount: 0,
  issueCount: 0,
  conversationCount: 0,
  cursor: null,
  outboxSize: 0,
  outboxDeadLetterCount: 0,
}
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

/** These lazy computeds belong to Settings. No host capacity is shown here;
 * only the twelve displayed machine identities and the fleet's scalar labels
 * leave this reader. Unrelated diagnostic changes do not rebuild the fleet. */
function machineReaders(pool: MobxPool) {
  return pool.sources.view('phone.settings.machines', () => {
    const ids = keyedComputed('phone.settings.machineIds', (_key: null) => {
      const catalog = pool.row('settingsCatalog', 'catalog')
      return loaded(catalog) ? catalog.machines : EMPTY_IDS
    })
    const shown = keyedComputed('phone.settings.shownMachineIds', (_key: null) =>
      ids(null).slice(0, 12),
    )
    const flags = keyedComputed('phone.settings.machineFlags', (id: string) => {
      const row = pool.row('settingsMachine', id)
      if (!loaded(row)) return null
      const view = visibleFleetOperations({ machines: [row], hosts: [] }).machines[0]!
      return JSON.stringify([view.online, view.updateState])
    })
    const summary = keyedComputed('phone.settings.fleetSummary', (_key: null) => {
      let count = 0,
        online = 0,
        behind = 0,
        ahead = 0,
        unreported = 0
      for (const id of ids(null)) {
        const raw = flags(id)
        if (raw === null) continue
        const [live, update] = JSON.parse(raw) as [boolean, MachineOperationsView['updateState']]
        count++
        if (live) online++
        if (update === 'behind') behind++
        if (update === 'ahead') ahead++
        if (update === 'unreported' || update === 'unknown') unreported++
      }
      const fleetLabel =
        count === 0
          ? 'No visible machines'
          : `${online} of ${count} visible ${count === 1 ? 'machine' : 'machines'} online`
      const updateLabel =
        behind > 0
          ? `${behind} ${behind === 1 ? 'machine' : 'machines'} behind`
          : ahead > 0
            ? `${ahead} ${ahead === 1 ? 'machine' : 'machines'} ahead`
            : unreported > 0
              ? `${unreported} without a comparable build`
              : count === 0
                ? 'No visible machines'
                : 'All visible machines current'
      return JSON.stringify({ machineCount: count, fleetLabel, updateLabel })
    })
    const status = keyedComputed(
      'phone.settings.machineStatus',
      (id: string): SettingsMachineStatus | null => {
        const row = pool.row('settingsMachine', id)
        if (!loaded(row)) return null
        const view = visibleFleetOperations({ machines: [row], hosts: [] }).machines[0]!
        const { name, online, statusLabel, updateChannel, updateLabel } = view
        return { id, name, online, statusLabel, updateChannel, updateLabel }
      },
    )
    return {
      shown,
      summary,
      status,
      dispose() {
        ids.clear()
        shown.clear()
        flags.clear()
        summary.clear()
        status.clear()
      },
    }
  })
}

export function readSettingsData(pool: MobxPool): SettingsData {
  const diagnostics = pool.row('mobileSettingsDiagnostics', 'diagnostics')
  const window = pool.row('window', 'window') as { outboxSize: number } | undefined
  const notices = pool.row('noticeCatalog', 'catalog')
  const machines = machineReaders(pool)
  return {
    ...(JSON.parse(machines.summary(null)) as Pick<
      SettingsData,
      'machineCount' | 'fleetLabel' | 'updateLabel'
    >),
    machineIds: machines.shown(null),
    sessionCount: settingsView(pool).sessionCount(),
    issueCount: loaded(diagnostics) ? diagnostics.issueCount : 0,
    conversationCount: loaded(diagnostics) ? diagnostics.conversationCount : 0,
    cursor: loaded(diagnostics) ? diagnostics.cursor : null,
    outboxSize: window?.outboxSize ?? 0,
    outboxDeadLetterCount: loaded(notices) ? notices.deadLetters.length : 0,
  }
}
export function useSettingsMachineStatus(id: string): SettingsMachineStatus | null {
  const read = useCallback((pool: MobxPool) => machineReaders(pool).status(id), [id])
  return useMobilePoolProjection(read, null)
}
export function useSettingsData(): SettingsData {
  return useMobilePoolProjection(readSettingsData, EMPTY_SETTINGS)
}
