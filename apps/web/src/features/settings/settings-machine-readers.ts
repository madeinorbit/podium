import type { MachineModel, MobxPool } from '@podium/client-graph'
import { omitGone } from '@podium/client-graph/lookup'
import { keyedComputed, lazy } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'

const EMPTY_MACHINE_IDS: readonly string[] = []
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

const EMPTY_MACHINES: MachineModel[] = []
export class SettingsMachines {
  constructor(private readonly pool: MobxPool) {}
  @lazy({ equals: compareShallow }) get authorized(): MachineModel[] {
    // Authorization is independent of presence: personal defaults also apply
    // when an offline machine next launches against its last stored catalog.
    return this.values.filter((machine) => machine.use === 'granted')
  }
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
  return {
    models,
    ids,
    dispose() {
      ids.clear()
    },
  }
}
