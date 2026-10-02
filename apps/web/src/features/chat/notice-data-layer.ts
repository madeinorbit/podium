/** One startup choice for all notice readers, default OFF. Principal rebuilds
 * retain the latched choice; rollout retirement belongs to POD-5174. */
let startup: 'legacy' | 'pool' | undefined
let check = false
export function initializeNoticesDataLayer(): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR. */ }
  startup = params?.get('mobxNotices') === '1' ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxNoticesCheck') === '1'
}
export function noticesDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function noticesCheckRequested(): boolean { return check }

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
initializeNoticesDataLayer()
