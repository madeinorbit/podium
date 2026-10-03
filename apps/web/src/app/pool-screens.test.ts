import { MOBX_SIDEBAR_KEY, type UiState } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })

it('initializes every converted screen from the shared MobX pilot setting before mount', async () => {
  history.replaceState(null, '', '/')
  const { poolBackedScreens, initializePoolScreens } = await import('./pool-screens')
  const { automationsDataLayer, specsDataLayer } = await import('@/lib/automations-data-layer')
  const { noticesDataLayer } = await import('@/features/chat/notice-data-layer')
  expect(poolBackedScreens.length).toBeGreaterThanOrEqual(5)
  expect(poolBackedScreens.filter(screen => screen.enabled).every(screen => !screen.enabled!())).toBe(true)
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
  expect(poolBackedScreens.every(screen => screen.enabled?.() !== false)).toBe(true)

  // The next principal/provider and a preference edit share the app-load latch.
  values.set(MOBX_SIDEBAR_KEY, '0')
  initializePoolScreens(ui)
  expect(automationsDataLayer()).toBe('pool')
  expect(specsDataLayer()).toBe('pool')
  expect(noticesDataLayer()).toBe('pool')
  expect(poolBackedScreens.every(screen => screen.enabled?.() !== false)).toBe(true)

  vi.resetModules()
  const reloaded = await import('./pool-screens')
  reloaded.initializePoolScreens(ui)
  expect(reloaded.poolBackedScreens.filter(screen => screen.enabled).every(screen => !screen.enabled!())).toBe(true)
})

const permanentIds = ['sidebar', 'header', 'shell', 'mission', 'issuePage', 'sessionPane', 'pane', 'board']
it.each(['', '?mobxSidebar=0&mobxHeader=0&mobxChips=0&mobxPane=0&mobxSessionPane=0&mobxBoard=0&mobxShell=0&mobxMissionPane=0'])('keeps workspace readers unconditional with retired overrides: %s', async query => {
  history.replaceState(null, '', '/' + query)
  const { poolBackedScreens } = await import('./pool-screens')
  const screens = poolBackedScreens.filter(screen => permanentIds.includes(screen.id ?? ''))
  expect(screens).toHaveLength(permanentIds.length)
  expect(screens.every(screen => screen.initialize === undefined && screen.enabled === undefined)).toBe(true)
})
