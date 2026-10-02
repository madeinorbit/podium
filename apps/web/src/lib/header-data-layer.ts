import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from './mobx-pilot'

/** Frozen for the lifetime of this app load, including principal rebuilds.
 * The shared device setting defaults off; the URL overrides this screen only. */
const header = webPoolSwitch('mobxHeader', 'mobxHeaderCheck')
export function initializeHeaderDataLayer(ui: Pick<UiState, 'get'>): void { header.initialize(ui) }
export function headerDataLayer(): 'legacy' | 'pool' { return header.layer() }
export function headerCheckRequested(): boolean { return header.checkRequested() }
