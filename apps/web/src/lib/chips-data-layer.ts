import type { UiState } from '@podium/client-core/ui-state'
import type { PoolDataLayer } from '@podium/client-graph/host'
import { webPoolSwitch } from './mobx-pilot'

export { MOBX_CHIPS_KEY } from '@podium/client-core/ui-state'

export type ChipsDataLayer = PoolDataLayer

// One choice per app load. Principal rebuilds and preference edits never change
// a mounted reader's data source; the operator's rollback takes a reload.
const chips = webPoolSwitch('mobxChips', 'mobxChipsCheck')
let perf = false

export function initializeChipsDataLayer(ui: Pick<UiState, 'get'>): void {
  const storage = chips.initialize(ui)
  if (storage) perf = storage.get('chipsPerf') === '1'
}

export function chipsDataLayer(): ChipsDataLayer {
  return chips.layer()
}
export function chipsCheckRequested(): boolean {
  return chips.checkRequested()
}
export function chipsPerfRequested(): boolean {
  return perf
}
