import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

const stored = (value: string | null) => ({
  get: vi.fn((key: string) => key === MOBX_SIDEBAR_KEY ? value : null),
})

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })

it.each([
  ['', '1', 'pool'],
  ['?mobxPreferences=0', '1', 'legacy'],
  ['?mobxPreferences=1', '0', 'pool'],
] as const)('uses the shared MobX pilot setting with URL precedence: %s', async (query, setting, expected) => {
  history.replaceState(null, '', `/${query}`)
  const mode = await import('./preferences-data-layer')
  mode.initializePreferencesDataLayer(stored(setting))
  expect(mode.preferencesDataLayer()).toBe(expected)
  expect(mode.preferencesCheckRequested()).toBe(false)
  history.replaceState(null, '', expected === 'pool' ? '/?mobxPreferences=0&mobxPreferencesCheck=1' : '/?mobxPreferences=1&mobxPreferencesCheck=1')
  mode.initializePreferencesDataLayer(stored(setting === '1' ? '0' : '1'))
  expect(mode.preferencesDataLayer()).toBe(expected)
  expect(mode.preferencesCheckRequested()).toBe(false)
})

it('defaults off and latches the startup preference switch across later navigation', async () => {
  history.replaceState(null, '', '/')
  vi.resetModules()
  const off = await import('./preferences-data-layer')
  off.initializePreferencesDataLayer(stored(null))
  expect(off.preferencesDataLayer()).toBe('legacy')
  history.replaceState(null, '', '/?mobxPreferences=1&mobxPreferencesCheck=1')
  off.initializePreferencesDataLayer(stored('1'))
  expect(off.preferencesDataLayer()).toBe('legacy')
  vi.resetModules()
  const on = await import('./preferences-data-layer')
  on.initializePreferencesDataLayer(stored(null))
  expect(on.preferencesDataLayer()).toBe('pool')
  expect(on.preferencesCheckRequested()).toBe(true)
  history.replaceState(null, '', '/?mobxPreferences=0')
  on.initializePreferencesDataLayer(stored('0'))
  expect(on.preferencesDataLayer()).toBe('pool')
})
