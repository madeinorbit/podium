import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from '@/lib/mobx-pilot'

/** One startup choice for all notice readers, default OFF. Principal rebuilds
 * retain the latched choice; rollout retirement belongs to POD-5174. */
const notices = webPoolSwitch('mobxNotices', 'mobxNoticesCheck')
export function initializeNoticesDataLayer(ui: Pick<UiState, 'get'>): void { notices.initialize(ui) }
export function noticesDataLayer(): 'legacy' | 'pool' { return notices.layer() }
export function noticesCheckRequested(): boolean { return notices.checkRequested() }

type Work = 'messageSelectors' | 'messageDerivations' | 'interactionSelectors' | 'interactionDerivations' | 'recoverySelectors'
let counting = false
let counts = new WeakMap<object, Partial<Record<Work, number>>>()
export const noticeReadStats = {
  enable(value = true) { counting = value },
  reset() { counts = new WeakMap() },
  read(owner: object) { return counts.get(owner) ?? {} },
}
export function recordLegacyNoticeWork(owner: object, work: Work): void {
  if (!counting) return
  const values = counts.get(owner) ?? {}
  values[work] = (values[work] ?? 0) + 1
  counts.set(owner, values)
}
