/** Settings and activation share one startup choice. Reload to roll back;
 * principal changes and navigation never change a mounted hook's order. */
let startup: 'legacy' | 'pool' | undefined
let check = false

export function initializeSettingsDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = mobxPilotEnabled(ui, params, 'mobxSettings') ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxSettingsCheck') === '1'
}

export function settingsDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function settingsCheckRequested(): boolean { return check }
import type { UiState } from '@podium/client-core/ui-state'
import { mobxPilotEnabled } from '@/lib/mobx-pilot'
