import type { UiState } from '@podium/client-core/ui-state'
import { mobxPilotEnabled } from './mobx-pilot'

export { MOBX_CHIPS_KEY } from '@podium/client-core/ui-state'

export type ChipsDataLayer = 'legacy' | 'pool'

// One choice per app load. Principal rebuilds and preference edits never change
// a mounted reader's data source; the operator's rollback takes a reload.
let startup: ChipsDataLayer | undefined
let check = false
let perf = false

export function initializeChipsDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startup !== undefined) return
  const params =
    typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)
  perf = params.get('chipsPerf') === '1'
  const enabled = mobxPilotEnabled(ui, params, 'mobxChips')
  startup = enabled ? 'pool' : 'legacy'
  check = enabled && params.get('mobxChipsCheck') === '1'
}

export function chipsDataLayer(): ChipsDataLayer {
  return startup ?? 'legacy'
}
export function chipsCheckRequested(): boolean {
  return check
}
export function chipsPerfRequested(): boolean {
  return perf
}
