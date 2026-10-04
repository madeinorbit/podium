import type { UiState } from '@podium/client-core/ui-state'

// TEMPORARY (POD-5432): the revert path for the pool owning optimism. Pool
// screens paint from the pool's transaction log by default (the host's
// POOL_OWNED_KINDS); only the `?poolTransactions=0` URL override hands them
// back to the runtime's ledger for this app load. It is a pool-wide option,
// not a screen: it builds no pool by itself. Delete with the ledger (F4).
let transactionsEnabled: boolean | undefined

/** Latch once per app load, independently of the reader pilot. */
export function initializePoolTransactions(_ui: Pick<UiState, 'get'>): void {
  if (transactionsEnabled !== undefined) return
  let params: URLSearchParams | undefined
  try {
    if (typeof location !== 'undefined') params = new URLSearchParams(location.search)
  } catch {
    // SSR: the default.
  }
  const value = params?.get('poolTransactions')
  transactionsEnabled = value !== '0' && value !== 'false'
}

/** Pool screens paint from the pool's transaction log, and pool writes go
 * through it, unless the revert override latched off. */
export function poolTransactionsEnabled(): boolean {
  return transactionsEnabled ?? false
}
