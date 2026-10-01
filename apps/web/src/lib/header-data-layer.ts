/** Frozen for the lifetime of this app load, including principal rebuilds.
 * Default off. The query override is the screen's one-week rollback switch. */
let startup: 'legacy' | 'pool' | undefined
let check = false
export function initializeHeaderDataLayer(): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = params?.get('mobxHeader') === '1' ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxHeaderCheck') === '1'
}
export function headerDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function headerCheckRequested(): boolean { return check }

initializeHeaderDataLayer()
