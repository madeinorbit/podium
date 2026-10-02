import { MOBX_SIDEBAR_KEY, type UiState } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })

it('initializes every converted screen from the shared MobX pilot setting before mount', async () => {
  history.replaceState(null, '', '/')
  const { poolBackedScreens, initializePoolScreens } = await import('./pool-screens')
  const { automationsDataLayer, specsDataLayer } = await import('@/lib/automations-data-layer')
  const { noticesDataLayer } = await import('@/features/chat/notice-data-layer')
  expect(poolBackedScreens.length).toBeGreaterThanOrEqual(5)
  expect(poolBackedScreens.every(screen => !screen.enabled())).toBe(true)
  const values = new Map([[MOBX_SIDEBAR_KEY, '1']])
  const ui: UiState = {
    get: (key) => values.get(key) ?? null,
    set: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  }
  initializePoolScreens(ui)
  // Automations and specs share a registration; either one can enable it.
  // Check each reader's choice so a working sibling cannot hide a regression.
  expect(automationsDataLayer()).toBe('pool')
  expect(specsDataLayer()).toBe('pool')
  expect(noticesDataLayer()).toBe('pool')
  expect(poolBackedScreens.every(screen => screen.enabled())).toBe(true)

  // The next principal/provider and a preference edit share the app-load latch.
  values.set(MOBX_SIDEBAR_KEY, '0')
  initializePoolScreens(ui)
  expect(automationsDataLayer()).toBe('pool')
  expect(specsDataLayer()).toBe('pool')
  expect(noticesDataLayer()).toBe('pool')
  expect(poolBackedScreens.every(screen => screen.enabled())).toBe(true)

  vi.resetModules()
  const reloaded = await import('./pool-screens')
  reloaded.initializePoolScreens(ui)
  expect(reloaded.poolBackedScreens.every(screen => !screen.enabled())).toBe(true)
})
