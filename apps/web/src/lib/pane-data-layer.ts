import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from './mobx-pilot'

/** Read once per app load, default off. Principal rebuilds keep the startup
 * choice; changing the rollback switch requires a reload. */
const pane = webPoolSwitch('mobxPane')
export function initializePaneDataLayer(ui: Pick<UiState, 'get'>): void { pane.initialize(ui) }
export function paneDataLayer(): 'legacy' | 'pool' { return pane.layer() }
