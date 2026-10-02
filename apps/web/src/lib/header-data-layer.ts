import type { UiState } from '@podium/client-core/ui-state'
import { mobxPilotEnabled } from './mobx-pilot'

/** Frozen for the lifetime of this app load, including principal rebuilds.
 * The shared device setting defaults off; the URL overrides this screen only. */
let startup: 'legacy' | 'pool' | undefined
let check = false
export function initializeHeaderDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = mobxPilotEnabled(ui, params, 'mobxHeader') ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxHeaderCheck') === '1'
}
export function headerDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function headerCheckRequested(): boolean { return check }
