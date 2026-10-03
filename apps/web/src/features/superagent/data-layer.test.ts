import { afterEach, expect, it, vi } from 'vitest'
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('defaults off and latches the device setting once across changes and principals', async () => {
  vi.resetModules(); vi.stubGlobal('location', { search: '' })
  const layer = await import('./data-layer'), data = new Map<string, string>()
  const ui = { get: (key: string) => data.get(key) ?? null }
  layer.initializeSuperagentDataLayer(ui)
  expect(layer.superagentDataLayer()).toBe('legacy')
  data.set(MOBX_SIDEBAR_KEY, '1')
  layer.initializeSuperagentDataLayer(ui)
  expect(layer.superagentDataLayer()).toBe('legacy')
  vi.resetModules()
  const restarted = await import('./data-layer')
  restarted.initializeSuperagentDataLayer(ui)
  expect(restarted.superagentDataLayer()).toBe('pool')
})
it('uses the shared pilot preference with an independent startup URL override and check', async () => {
  vi.resetModules(); vi.stubGlobal('location', { search: '?mobxSuperagent=1&mobxSuperagentCheck=1' })
  const layer = await import('./data-layer')
  layer.initializeSuperagentDataLayer({ get: () => null })
  expect(layer.superagentDataLayer()).toBe('pool')
  expect(layer.superagentCheckRequested()).toBe(true)
  vi.stubGlobal('location', { search: '?mobxSuperagent=0' })
  layer.initializeSuperagentDataLayer({ get: () => null })
  expect(layer.superagentDataLayer()).toBe('pool')
})
