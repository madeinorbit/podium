// @vitest-environment happy-dom
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

const stored = (value: string | null) => ({ get: (key: string) => key === MOBX_SIDEBAR_KEY ? value : null })
afterEach(() => { vi.resetModules(); history.replaceState(null, '', '/') })

it('defaults OFF and never relatches after startup, including a principal rebuild', async () => {
  const flags = await import('./data-layer')
  expect(flags.workflowsDataLayer()).toBe('legacy')
  flags.initializeWorkflowsDataLayer(stored(null))
  history.replaceState(null, '', '/?mobxWorkflows=1&mobxWorkflowsCheck=1')
  flags.initializeWorkflowsDataLayer(stored('1'))
  expect(flags.workflowsDataLayer()).toBe('legacy')
  expect(flags.workflowsCheckRequested()).toBe(false)
})

it.each([
  ['?mobxWorkflows=1&mobxWorkflowsCheck=1', null, 'pool', true],
  ['?mobxWorkflows=0&mobxWorkflowsCheck=1', '1', 'legacy', false],
  ['', '1', 'pool', false],
  ['?mobxAutomations=1&mobxWorkflowsCheck=1', null, 'legacy', false],
] as const)('respects the shared setting and independent URL precedence: %s', async (query, device, layer, check) => {
  history.replaceState(null, '', `/${query}`)
  const flags = await import('./data-layer')
  expect(flags.workflowsDataLayer()).toBe('legacy')
  flags.initializeWorkflowsDataLayer(stored(device))
  expect(flags.workflowsDataLayer()).toBe(layer)
  expect(flags.workflowsCheckRequested()).toBe(check)
  history.replaceState(null, '', '/?mobxWorkflows=0')
  flags.initializeWorkflowsDataLayer(stored(null))
  expect(flags.workflowsDataLayer()).toBe(layer)
})
