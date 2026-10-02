/** Read once per app load, default off. Principal rebuilds keep the startup
 * choice; changing the rollback switch requires a reload. */
let startup: 'legacy' | 'pool' | undefined
export function initializePaneDataLayer(): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = params?.get('mobxPane') === '1' ? 'pool' : 'legacy'
}
export function paneDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
initializePaneDataLayer()
