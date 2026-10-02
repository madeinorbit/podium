import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

const stored = (value: string | null) => ({ get: (key: string) => key === MOBX_SIDEBAR_KEY ? value : null })
afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })
it('defaults off and latches notices and their diagnostic choice once', async () => {
  history.replaceState(null, '', '/')
  vi.resetModules()
  const off = await import('./notice-data-layer')
  expect(off.noticesDataLayer()).toBe('legacy')
  off.initializeNoticesDataLayer(stored(null))
  history.replaceState(null, '', '/?mobxNotices=1&mobxNoticesCheck=1')
  off.initializeNoticesDataLayer(stored('1'))
  expect(off.noticesDataLayer()).toBe('legacy')
  expect(off.noticesCheckRequested()).toBe(false)
  vi.resetModules()
  const on = await import('./notice-data-layer')
  expect(on.noticesDataLayer()).toBe('legacy')
  on.initializeNoticesDataLayer(stored('0'))
  expect(on.noticesDataLayer()).toBe('pool')
  expect(on.noticesCheckRequested()).toBe(true)
  history.replaceState(null, '', '/?mobxNotices=0')
  on.initializeNoticesDataLayer(stored('0'))
  expect(on.noticesDataLayer()).toBe('pool')
  expect(on.noticesCheckRequested()).toBe(true)
})

it.each([
  ['', '1', 'pool'],
  ['?mobxNotices=0', '1', 'legacy'],
  ['?mobxNotices=1', '0', 'pool'],
] as const)('uses the shared pilot setting with URL precedence: %s', async (query, setting, expected) => {
  history.replaceState(null, '', `/${query}`)
  const flags = await import('./notice-data-layer')
  flags.initializeNoticesDataLayer(stored(setting))
  expect(flags.noticesDataLayer()).toBe(expected)
  expect(flags.noticesCheckRequested()).toBe(false)
  history.replaceState(null, '', expected === 'pool' ? '/?mobxNotices=0&mobxNoticesCheck=1' : '/?mobxNotices=1&mobxNoticesCheck=1')
  flags.initializeNoticesDataLayer(stored(setting === '1' ? '0' : '1'))
  expect(flags.noticesDataLayer()).toBe(expected)
  expect(flags.noticesCheckRequested()).toBe(false)
})

it.each([
  ['?mobxNoticesCheck=1', '1', true],
  ['?mobxNotices=0&mobxNoticesCheck=1', '1', false],
  ['?mobxNoticesCheck=1', null, false],
] as const)('requests diagnostics only when notices are enabled: %s, setting %s', async (query, setting, check) => {
  history.replaceState(null, '', `/${query}`)
  const flags = await import('./notice-data-layer')
  flags.initializeNoticesDataLayer(stored(setting))
  expect(flags.noticesCheckRequested()).toBe(check)
})
