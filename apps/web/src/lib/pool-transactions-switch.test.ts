import { MOBX_SIDEBAR_KEY, type UiState } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  history.replaceState(null, '', '/')
  vi.resetModules()
})

const ui = (values: Record<string, string>): UiState => ({
  get: (key) => values[key] ?? null,
  set: vi.fn(),
  subscribe: vi.fn(() => () => {}),
})

it('is on by default once latched, whatever the shared pool setting says', async () => {
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  expect(poolTransactionsEnabled()).toBe(false)
  initializePoolTransactions(ui({ [MOBX_SIDEBAR_KEY]: '0' }))
  expect(poolTransactionsEnabled()).toBe(true)
})

it('reverts to the ledger only through its URL override, latched for the app load', async () => {
  history.replaceState(null, '', '/?poolTransactions=0')
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  initializePoolTransactions(ui({}))
  expect(poolTransactionsEnabled()).toBe(false)
  history.replaceState(null, '', '/?poolTransactions=1')
  initializePoolTransactions(ui({}))
  expect(poolTransactionsEnabled()).toBe(false)
})
