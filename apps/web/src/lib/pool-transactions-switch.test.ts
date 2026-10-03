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

it('stays off by default, even where the shared pool setting is on', async () => {
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  expect(poolTransactionsEnabled()).toBe(false)
  initializePoolTransactions(ui({ [MOBX_SIDEBAR_KEY]: '1' }))
  expect(poolTransactionsEnabled()).toBe(false)
})

it('turns on only through its URL override, latched for the app load', async () => {
  history.replaceState(null, '', '/?poolTransactions=1')
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  initializePoolTransactions(ui({}))
  expect(poolTransactionsEnabled()).toBe(true)
  history.replaceState(null, '', '/?poolTransactions=0')
  initializePoolTransactions(ui({}))
  expect(poolTransactionsEnabled()).toBe(true)
})
