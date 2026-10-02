import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from '@/lib/mobx-pilot'

/** Settings and activation share one startup choice. Reload to roll back;
 * principal changes and navigation never change a mounted hook's order. */
const settings = webPoolSwitch('mobxSettings', 'mobxSettingsCheck')

export function initializeSettingsDataLayer(ui: Pick<UiState, 'get'>): void { settings.initialize(ui) }

export function settingsDataLayer(): 'legacy' | 'pool' { return settings.layer() }
export function settingsCheckRequested(): boolean { return settings.checkRequested() }
