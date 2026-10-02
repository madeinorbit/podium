/** Default OFF; frozen for this app load, including provider rebuilds. */
let startup: 'legacy' | 'pool' | undefined
let check = false
export function initializeCommandLaunchDataLayer(): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR */ }
  startup = params?.get('mobxCommands') === '1' ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxCommandsCheck') === '1'
}
export function commandLaunchDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function commandLaunchCheckRequested(): boolean { return check }

const owners = new WeakMap<object, { legacyReads: number }>()
let enabled = false
export const commandLaunchReadStats = {
  enable() { enabled = true },
  reset(owner: object) { owners.set(owner, { legacyReads: 0 }) },
  legacy(owner: object) { if (enabled) { const counts = owners.get(owner) ?? { legacyReads: 0 }; counts.legacyReads++; owners.set(owner, counts) } },
  read(owner: object) { return owners.get(owner) ?? { legacyReads: 0 } },
}
initializeCommandLaunchDataLayer()
