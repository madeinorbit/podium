import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from './mobx-pilot'

/** The shared device setting and URL override latch once for this app load,
 * including principal changes. Reload to apply a different choice. */
const preferences = webPoolSwitch('mobxPreferences', 'mobxPreferencesCheck')
export function initializePreferencesDataLayer(ui: Pick<UiState, 'get'>): void { preferences.initialize(ui) }
export function preferencesDataLayer(): 'legacy' | 'pool' { return preferences.layer() }
export function preferencesCheckRequested(): boolean { return preferences.checkRequested() }

// Per-owner counts; no snapshots, keys or values are retained by diagnostics.
let counting = false
let legacyReads = new WeakMap<object, number>()
export const preferenceReadStats = {
  enable(value = true) { counting = value },
  reset() { legacyReads = new WeakMap() },
  read(owner: object) { return { legacyReads: legacyReads.get(owner) ?? 0 } },
}
export function recordLegacyPreferenceRead(owner: object): void {
  if (counting) legacyReads.set(owner, (legacyReads.get(owner) ?? 0) + 1)
}
