import type { UiState } from '@podium/client-core/ui-state'
import { poolSwitches } from '@podium/client-graph/host'

// TEMPORARY (POD-5431): the pool's own transaction log, off by default. Only
// the `?poolTransactions=1` URL override turns it on; the shared device setting
// that turns pool screens on does not, so no device reaches it by accident. It
// is a pool-wide option, not a screen: it builds no pool by itself.
const transactions = poolSwitches(() => {
  let params: URLSearchParams | undefined
  try {
    if (typeof location !== 'undefined') params = new URLSearchParams(location.search)
  } catch {
    // SSR: off.
  }
  return { get: (key) => params?.get(key), device: () => false }
})('poolTransactions')

/** Latch with the screens, once per app load. */
export function initializePoolTransactions(ui: Pick<UiState, 'get'>): void {
  transactions.initialize(ui)
}

/** Pool screens paint from the pool's transaction log, and pool writes go
 * through it, when the switch latched on. */
export function poolTransactionsEnabled(): boolean {
  return transactions.layer() === 'pool'
}
