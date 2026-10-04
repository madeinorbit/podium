import type { UiState } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  history.replaceState(null, '', '/')
  vi.resetModules()
})

const ui = (values: Record<string, string>): UiState => ({
  get: vi.fn((key) => values[key] ?? null),
  set: vi.fn(),
  subscribe: vi.fn(() => () => {}),
})

// A preference left on an older install must not control transaction ownership.
const retiredReaderKey = 'podium.mobxSidebar'

it('is on by default once latched, whatever the shared pool setting says', async () => {
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  expect(poolTransactionsEnabled()).toBe(false)
  const owner = ui({ [retiredReaderKey]: '0' })
  initializePoolTransactions(owner)
  expect(poolTransactionsEnabled()).toBe(true)
  expect(owner.get).not.toHaveBeenCalled()
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

it.each([
  ['false', false],
  ['1', true],
  ['true', true],
  ['', true],
  ['no', true],
  ['FALSE', true],
  ['TRUE', true],
  ['%66alse', false],
  ['0&poolTransactions=1', false],
  ['1&poolTransactions=0', true],
])('preserves the URL override %s as enabled=%s', async (value, enabled) => {
  history.replaceState(null, '', `/?poolTransactions=${value}`)
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  initializePoolTransactions(ui({ [retiredReaderKey]: '1' }))
  expect(poolTransactionsEnabled()).toBe(enabled)
})

it('reads the current URL once at initialization and never reads either principal setting', async () => {
  let search = '?poolTransactions=1'
  const readSearch = vi.fn(() => search)
  vi.stubGlobal('location', {
    get search() {
      return readSearch()
    },
  })
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  expect(poolTransactionsEnabled()).toBe(false)
  expect(readSearch).not.toHaveBeenCalled()

  search = '?poolTransactions=false'
  const firstOwner = ui({ [retiredReaderKey]: '1' })
  initializePoolTransactions(firstOwner)
  expect(poolTransactionsEnabled()).toBe(false)
  expect(readSearch).toHaveBeenCalledTimes(1)

  search = '?poolTransactions=1'
  const nextOwner = ui({ [retiredReaderKey]: '0' })
  initializePoolTransactions(nextOwner)
  initializePoolTransactions(firstOwner)
  expect(poolTransactionsEnabled()).toBe(false)
  expect(readSearch).toHaveBeenCalledTimes(1)
  expect(firstOwner.get).not.toHaveBeenCalled()
  expect(nextOwner.get).not.toHaveBeenCalled()
  console.info('POD5438 transaction URL latch counters', {
    initializations: 3,
    urlReads: readSearch.mock.calls.length,
    settingReads:
      vi.mocked(firstOwner.get).mock.calls.length + vi.mocked(nextOwner.get).mock.calls.length,
  })
})

it('keeps the default when location is absent', async () => {
  vi.stubGlobal('location', undefined)
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  initializePoolTransactions(ui({}))
  expect(poolTransactionsEnabled()).toBe(true)
})

it('keeps the default when location cannot be read', async () => {
  vi.stubGlobal('location', {
    get search() {
      throw new Error('Location is unavailable')
    },
  })
  const { initializePoolTransactions, poolTransactionsEnabled } = await import(
    './pool-transactions-switch'
  )
  initializePoolTransactions(ui({}))
  expect(poolTransactionsEnabled()).toBe(true)
})
