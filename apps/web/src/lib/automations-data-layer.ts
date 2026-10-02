/** Default OFF. Both screen choices and diagnostic requests are latched once
 * per app startup, including principal changes. Rollback requires a reload. */
let automations: 'legacy' | 'pool' | undefined
let specs: 'legacy' | 'pool' | undefined
let check = false
export function initializeAutomationsDataLayer(): void {
  if (automations !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR */ }
  automations = params?.get('mobxAutomations') === '1' ? 'pool' : 'legacy'
  specs = params?.get('mobxSpecs') === '1' ? 'pool' : 'legacy'
  check = (automations === 'pool' || specs === 'pool') && params?.get('mobxAutomationsCheck') === '1'
}
export const automationsDataLayer = () => automations ?? 'legacy'
export const specsDataLayer = () => specs ?? 'legacy'
export const automationsCheckRequested = () => check

let counting = false
let owners = new WeakMap<object, Record<string, number>>()
export const automationReadStats = {
  enable(value = true) { counting = value },
  reset() { owners = new WeakMap() },
  read(owner: object) { return { ...(owners.get(owner) ?? {}) } },
}
export function recordLegacyAutomationRead(owner: object, reader: string): void {
  if (!counting) return
  const counts = owners.get(owner) ?? {}
  counts[reader] = (counts[reader] ?? 0) + 1
  owners.set(owner, counts)
}
initializeAutomationsDataLayer()
