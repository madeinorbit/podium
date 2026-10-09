import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph'
import { keyedComputed } from '@podium/mobx-helpers'
import { visibleFleetOperations } from '@podium/client-core/values'
import type { MachineOperationsView } from '@podium/client-core/values'
export type SettingsMachineStatus = Pick<MachineOperationsView, 'id' | 'name' | 'online' | 'statusLabel' | 'updateChannel' | 'updateLabel'>
const EMPTY_IDS: readonly string[] = []
const UPDATE_STATES = ['current', 'behind', 'ahead', 'unreported', 'unknown'] as const
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

export function createSettingsMachineReaders(pool: MobxPool) {
  const ids = keyedComputed('phone.settings.machineIds', (_key: null) => {
    const catalog = omitGone(pool.row('settingsCatalog', 'catalog'))
    return loaded(catalog) ? catalog.machines : EMPTY_IDS
  })
  const shown = keyedComputed('phone.settings.shownMachineIds', (_key: null) =>
    ids(null).slice(0, 12),
  )
  const flags = keyedComputed('phone.settings.machineFlags', (id: string) => {
    const row = omitGone(pool.model('machine', id))
    if (!loaded(row)) return -1
    const view = visibleFleetOperations({ machines: [row], hosts: [] }).machines[0]!
    return (UPDATE_STATES.indexOf(view.updateState) << 1) | Number(view.online)
  })
  const summary = keyedComputed('phone.settings.fleetSummary', (_key: null) => {
    let count = 0,
      online = 0,
      behind = 0,
      ahead = 0,
      unreported = 0
    for (const id of ids(null)) {
      const bits = flags(id)
      if (bits < 0) continue
      const live = bits & 1,
        update = UPDATE_STATES[bits >> 1]
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
    return { machineCount: count, fleetLabel, updateLabel }
  })
  const status = keyedComputed(
    'phone.settings.machineStatus',
    (id: string): SettingsMachineStatus | null => {
      const row = omitGone(pool.model('machine', id))
      if (!loaded(row)) return null
      const view = visibleFleetOperations({ machines: [row], hosts: [] }).machines[0]!
      const { name, online, statusLabel, updateChannel, updateLabel } = view
      return { id: view.id, name, online, statusLabel, updateChannel, updateLabel }
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
}
