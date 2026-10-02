import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from '@/lib/mobx-pilot'

/** Default OFF. Both screen choices and diagnostic requests are latched once
 * per app startup, including principal changes. Rollback requires a reload. */
const automations = webPoolSwitch('mobxAutomations', 'mobxAutomationsCheck')
const specs = webPoolSwitch('mobxSpecs', 'mobxAutomationsCheck')
export function initializeAutomationsDataLayer(ui: Pick<UiState, 'get'>): void {
  automations.initialize(ui)
  specs.initialize(ui)
}
export function automationsDataLayer(): 'legacy' | 'pool' { return automations.layer() }
export function specsDataLayer(): 'legacy' | 'pool' { return specs.layer() }
export function automationsCheckRequested(): boolean { return automations.checkRequested() || specs.checkRequested() }

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
