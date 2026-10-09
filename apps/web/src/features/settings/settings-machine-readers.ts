import { omitGone } from '@podium/client-graph/lookup'
import type { MachineModel, MobxPool } from '@podium/client-graph'
import { compareShallow } from 'mobx'
import { keyedComputed, lazy } from '@podium/mobx-helpers'
const EMPTY_MACHINE_IDS: readonly string[] = []
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

const EMPTY_MACHINES: MachineModel[] = []
export class SettingsMachines {
  constructor(private readonly pool: MobxPool) {}
  @lazy({ equals: compareShallow }) get values(): MachineModel[] {
    const catalog = omitGone(this.pool.row('settingsCatalog', 'catalog'))
    if (!loaded(catalog)) return EMPTY_MACHINES
    return catalog.machines.flatMap((id) => {
      const model = omitGone(this.pool.model('machine', id))
      return loaded(model) ? [model] : []
    })
  }
}

export function createSettingsMachineReaders(pool: MobxPool) {
  const models = new SettingsMachines(pool)
  const ids = keyedComputed('settings.machineIds', (_key: null) => {
    const catalog = omitGone(pool.row('settingsCatalog', 'catalog'))
    return loaded(catalog) ? catalog.machines : EMPTY_MACHINE_IDS
  })
  const override = keyedComputed('settings.machineChannel', (id: string) => {
    const row = omitGone(pool.model('machine', id))
    return loaded(row) ? (row.updateChannelOverride ?? null) : null
  })
  const version = keyedComputed('settings.machineTarget', (id: string) => {
    const row = omitGone(pool.model('machine', id))
    return loaded(row) ? (row.targetVersion ?? null) : null
  })
  const targets = keyedComputed('settings.channelTargets', (channel: string | null) => {
    const result: Record<string, string> = {}
    for (const id of ids(null)) {
      const selected = override(id) ?? channel
      const target = version(id)
      if (selected && target) result[selected] ??= target
    }
    return result
  })
  return {
    models,
    ids,
    targets,
    dispose() {
      ids.clear()
      override.clear()
      version.clear()
      targets.clear()
    },
  }
}
