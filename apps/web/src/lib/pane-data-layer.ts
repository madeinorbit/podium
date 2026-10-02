import type { UiState } from '@podium/client-core/ui-state'
import { mobxPilotEnabled } from './mobx-pilot'

/** Read once per app load, default off. Principal rebuilds keep the startup
 * choice; changing the rollback switch requires a reload. */
let startup: 'legacy' | 'pool' | undefined
export function initializePaneDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = mobxPilotEnabled(ui, params, 'mobxPane') ? 'pool' : 'legacy'
}
export function paneDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
