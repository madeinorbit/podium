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
  expect(screens).toHaveLength(convertedIds.length)
  for (const screen of screens) {
    expect(screen).not.toHaveProperty('initialize')
    expect(screen).not.toHaveProperty('enabled')
  }
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
  for (const screen of screens) {
    expect(screen).not.toHaveProperty('initialize')
    expect(screen).not.toHaveProperty('enabled')
  }
})
