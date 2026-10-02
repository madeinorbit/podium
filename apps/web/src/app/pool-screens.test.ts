import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })

it('initializes every converted screen from the shared MobX pilot setting before mount', async () => {
  history.replaceState(null, '', '/')
  const { poolBackedScreens } = await import('./pool-screens')
  expect(poolBackedScreens.length).toBeGreaterThanOrEqual(5)
  expect(poolBackedScreens.every(screen => !screen.enabled())).toBe(true)
  const values = new Map([[MOBX_SIDEBAR_KEY, '1']])
  const ui = { get: (key: string) => values.get(key) ?? null }
  for (const screen of poolBackedScreens) screen.initialize(ui)
  expect(poolBackedScreens.every(screen => screen.enabled())).toBe(true)

  // The next principal/provider and a preference edit share the app-load latch.
  values.set(MOBX_SIDEBAR_KEY, '0')
  for (const screen of poolBackedScreens) screen.initialize(ui)
  expect(poolBackedScreens.every(screen => screen.enabled())).toBe(true)

  vi.resetModules()
  const reloaded = await import('./pool-screens')
  for (const screen of reloaded.poolBackedScreens) screen.initialize(ui)
  expect(reloaded.poolBackedScreens.every(screen => !screen.enabled())).toBe(true)
})
