// @vitest-environment happy-dom
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

const stored = (value: string | null) => ({ get: (key: string) => key === MOBX_SIDEBAR_KEY ? value : null })
afterEach(() => { vi.resetModules(); history.replaceState(null, '', '/') })

it('automation and specs switches default OFF and stay latched after a URL change', async () => {
  history.replaceState(null, '', '/')
  const flags = await import('@/lib/automations-data-layer')
  expect(flags.automationsDataLayer()).toBe('legacy')
  expect(flags.specsDataLayer()).toBe('legacy')
  flags.initializeAutomationsDataLayer(stored(null))
  history.replaceState(null, '', '/?mobxAutomations=1&mobxSpecs=1&mobxAutomationsCheck=1')
  flags.initializeAutomationsDataLayer(stored('1'))
  expect(flags.automationsDataLayer()).toBe('legacy')
  expect(flags.specsDataLayer()).toBe('legacy')
  expect(flags.automationsCheckRequested()).toBe(false)
})

it.each([
  ['mobxAutomations', 'pool', 'legacy'],
  ['mobxSpecs', 'legacy', 'pool'],
] as const)('%s can opt in independently and stays ON until reload', async (key, automations, specs) => {
  history.replaceState(null, '', `/?${key}=1&mobxAutomationsCheck=1`)
  const flags = await import('@/lib/automations-data-layer')
  // Importing a screen must not latch before the hydrated setting is available.
  expect(flags.automationsDataLayer()).toBe('legacy')
  expect(flags.specsDataLayer()).toBe('legacy')
  flags.initializeAutomationsDataLayer(stored('0'))
  expect(flags.automationsDataLayer()).toBe(automations)
  expect(flags.specsDataLayer()).toBe(specs)
  expect(flags.automationsCheckRequested()).toBe(true)
  history.replaceState(null, '', '/')
  flags.initializeAutomationsDataLayer(stored('1'))
  expect(flags.automationsDataLayer()).toBe(automations)
  expect(flags.specsDataLayer()).toBe(specs)
  expect(flags.automationsCheckRequested()).toBe(true)
})

it.each([
  ['', 'pool', 'pool'],
  ['?mobxAutomations=0', 'legacy', 'pool'],
  ['?mobxSpecs=0', 'pool', 'legacy'],
] as const)('uses the shared pilot setting with independent URL precedence: %s', async (query, automations, specs) => {
  history.replaceState(null, '', `/${query}`)
  const flags = await import('@/lib/automations-data-layer')
  flags.initializeAutomationsDataLayer(stored('1'))
  expect(flags.automationsDataLayer()).toBe(automations)
  expect(flags.specsDataLayer()).toBe(specs)
  expect(flags.automationsCheckRequested()).toBe(false)
})

it.each([
  ['?mobxAutomationsCheck=1', '1', true],
  ['?mobxAutomations=0&mobxAutomationsCheck=1', '1', true],
  ['?mobxAutomations=0&mobxSpecs=0&mobxAutomationsCheck=1', '1', false],
  ['?mobxAutomationsCheck=1', null, false],
] as const)('requests diagnostics only when a screen is enabled: %s, setting %s', async (query, setting, check) => {
  history.replaceState(null, '', `/${query}`)
  const flags = await import('@/lib/automations-data-layer')
  flags.initializeAutomationsDataLayer(stored(setting))
  expect(flags.automationsCheckRequested()).toBe(check)
})
