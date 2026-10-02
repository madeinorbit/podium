/** Settings and activation share one startup choice. Reload to roll back;
 * principal changes and navigation never change a mounted hook's order. */
let startup: 'legacy' | 'pool' | undefined
let check = false

export function initializeSettingsDataLayer(): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = params?.get('mobxSettings') === '1' ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxSettingsCheck') === '1'
}

export function settingsDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function settingsCheckRequested(): boolean { return check }
initializeSettingsDataLayer()
