import type { UiState } from '@podium/client-core/ui-state'
import { mobxPilotEnabled } from '@/lib/mobx-pilot'

let startup: 'legacy' | 'pool' | undefined
let check = false
export function initializeSessionPaneDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR */ }
  startup = mobxPilotEnabled(ui, params, 'mobxSessionPane') ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxSessionPaneCheck') === '1'
}
export function sessionPaneDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function sessionPaneCheckRequested(): boolean { return check }
