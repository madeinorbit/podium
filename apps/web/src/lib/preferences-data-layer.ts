/** Default OFF; query choice is latched once for this app load, including
 * principal changes. Delete the legacy arm after the operator's rollout week. */
let startup: 'legacy' | 'pool' | undefined
let check = false
export function initializePreferencesDataLayer(): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = params?.get('mobxPreferences') === '1' ? 'pool' : 'legacy'
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
initializePreferencesDataLayer()
