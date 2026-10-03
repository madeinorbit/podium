import type { UiState } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  history.replaceState(null, '', '/')
  vi.resetModules()
})

const convertedIds = [
  'chatContext',
  'commands',
  'notices',
  'superagent',
  'workflows',
  'automations',
  'settings',
  'preferences',
]
it.each([
  '',
  '?mobxChatContext=0&mobxCommands=0&mobxNotices=0&mobxSuperagent=0&mobxWorkflows=0&mobxPreferences=0&mobxSettings=0&mobxAutomations=0&mobxSpecs=0',
])('keeps remaining converted screens on the sole pool read path: %s', async (query) => {
  history.replaceState(null, '', '/' + query)
  const { poolBackedScreens } = await import('./pool-screens')
  const screens = poolBackedScreens.filter((screen) => convertedIds.includes(screen.id ?? ''))
  const get = vi.fn(() => null)
  const ui: UiState = { get, set: vi.fn(), subscribe: vi.fn(() => () => {}) }
  expect(screens).toHaveLength(convertedIds.length)
  expect(
    screens.every((screen) => screen.initialize === undefined && screen.enabled === undefined),
  ).toBe(true)
  for (const screen of screens) {
    screen.initialize?.(ui)
    expect(screen.enabled?.()).not.toBe(false)
  }
  expect(get).not.toHaveBeenCalled()
})

const permanentIds = [
  'sidebar',
  'header',
  'shell',
  'mission',
  'issuePage',
  'sessionPane',
  'pane',
  'board',
]
it.each([
  '',
  '?mobxSidebar=0&mobxHeader=0&mobxChips=0&mobxPane=0&mobxSessionPane=0&mobxBoard=0&mobxShell=0&mobxMissionPane=0',
])('keeps workspace readers unconditional with retired overrides: %s', async (query) => {
  history.replaceState(null, '', '/' + query)
  const { poolBackedScreens } = await import('./pool-screens')
  const screens = poolBackedScreens.filter((screen) => permanentIds.includes(screen.id ?? ''))
  expect(screens).toHaveLength(permanentIds.length)
  expect(
    screens.every((screen) => screen.initialize === undefined && screen.enabled === undefined),
  ).toBe(true)
})
