import type { UiState } from '@podium/client-core/ui-state'
import { poolSwitches } from '@podium/client-graph/host'

// TEMPORARY (POD-5432): the revert path for the pool owning optimism. Pool
// screens paint from the pool's transaction log by default (the host's
// POOL_OWNED_KINDS); only the `?poolTransactions=0` URL override hands them
// back to the runtime's ledger for this app load. It is a pool-wide option,
// not a screen: it builds no pool by itself. Delete with the ledger (F4).
const transactions = poolSwitches(() => {
  let params: URLSearchParams | undefined
  try {
    if (typeof location !== 'undefined') params = new URLSearchParams(location.search)
  } catch {
    // SSR: the default.
  }
  return { get: (key) => params?.get(key), device: () => true }
})('poolTransactions')

/** Latch with the screens, once per app load. */
export function initializePoolTransactions(ui: Pick<UiState, 'get'>): void {
  transactions.initialize(ui)
}

/** Pool screens paint from the pool's transaction log, and pool writes go
 * through it, unless the revert override latched off. */
export function poolTransactionsEnabled(): boolean {
  return transactions.layer() === 'pool'
}
