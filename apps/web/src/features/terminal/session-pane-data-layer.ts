import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from '@/lib/mobx-pilot'

const pane = webPoolSwitch('mobxSessionPane', 'mobxSessionPaneCheck')
export function initializeSessionPaneDataLayer(ui: Pick<UiState, 'get'>): void { pane.initialize(ui) }
export function sessionPaneDataLayer(): 'legacy' | 'pool' { return pane.layer() }
export function sessionPaneCheckRequested(): boolean { return pane.checkRequested() }
