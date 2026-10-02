import type { UiState } from '@podium/client-core/ui-state'
import { mobxPilotEnabled } from './mobx-pilot'

/** The shared device setting and URL override latch once for this app load,
 * including principal changes. Reload to apply a different choice. */
let startup: 'legacy' | 'pool' | undefined
let check = false
export function initializePreferencesDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = mobxPilotEnabled(ui, params, 'mobxPreferences') ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxPreferencesCheck') === '1'
}
export function preferencesDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function preferencesCheckRequested(): boolean { return check }

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
