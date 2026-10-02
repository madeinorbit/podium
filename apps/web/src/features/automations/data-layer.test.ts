// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { vi.resetModules(); history.replaceState(null, '', '/') })

it('automation and specs switches default OFF and stay latched after a URL change', async () => {
  history.replaceState(null, '', '/')
  const flags = await import('@/lib/automations-data-layer')
  expect(flags.automationsDataLayer()).toBe('legacy')
  expect(flags.specsDataLayer()).toBe('legacy')
  history.replaceState(null, '', '/?mobxAutomations=1&mobxSpecs=1&mobxAutomationsCheck=1')
  flags.initializeAutomationsDataLayer()
  expect(flags.automationsDataLayer()).toBe('legacy')
  expect(flags.specsDataLayer()).toBe('legacy')
  expect(flags.automationsCheckRequested()).toBe(false)
})

it('each screen can opt in independently and stays ON until reload', async () => {
  history.replaceState(null, '', '/?mobxAutomations=1&mobxAutomationsCheck=1')
  const flags = await import('@/lib/automations-data-layer')
  expect(flags.automationsDataLayer()).toBe('pool')
  expect(flags.specsDataLayer()).toBe('legacy')
  expect(flags.automationsCheckRequested()).toBe(true)
  history.replaceState(null, '', '/')
  flags.initializeAutomationsDataLayer()
  expect(flags.automationsDataLayer()).toBe('pool')
})
