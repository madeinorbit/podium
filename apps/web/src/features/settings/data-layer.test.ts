import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, describe, expect, it, vi } from 'vitest'

const stored = (value: string | null) => ({
  get: vi.fn((key: string) => key === MOBX_SIDEBAR_KEY ? value : null),
})

afterEach(() => { window.history.replaceState({}, '', '/'); vi.resetModules() })

describe('settings startup choice', () => {
  it.each([
    ['', '1', 'pool'],
    ['?mobxSettings=0', '1', 'legacy'],
    ['?mobxSettings=1', '0', 'pool'],
  ] as const)('uses the shared MobX pilot setting with URL precedence: %s', async (query, setting, expected) => {
    window.history.replaceState({}, '', `/${query}`)
    const layer = await import('./data-layer')
    layer.initializeSettingsDataLayer(stored(setting))
    expect(layer.settingsDataLayer()).toBe(expected)
    expect(layer.settingsCheckRequested()).toBe(false)
    window.history.replaceState({}, '', expected === 'pool' ? '/?mobxSettings=0&mobxSettingsCheck=1' : '/?mobxSettings=1&mobxSettingsCheck=1')
    layer.initializeSettingsDataLayer(stored(setting === '1' ? '0' : '1'))
    expect(layer.settingsDataLayer()).toBe(expected)
    expect(layer.settingsCheckRequested()).toBe(false)
  })

  it('defaults off and does not enable checks in legacy mode', async () => {
    window.history.replaceState({}, '', '/?mobxSettingsCheck=1')
    vi.resetModules()
    const layer = await import('./data-layer')
    layer.initializeSettingsDataLayer(stored(null))
    expect(layer.settingsDataLayer()).toBe('legacy')
    expect(layer.settingsCheckRequested()).toBe(false)
  })

  it('latches the initial choice across navigation and principal initialization', async () => {
    window.history.replaceState({}, '', '/?mobxSettings=1&mobxSettingsCheck=1')
    vi.resetModules()
    const layer = await import('./data-layer')
    layer.initializeSettingsDataLayer(stored(null))
    expect(layer.settingsDataLayer()).toBe('pool')
    expect(layer.settingsCheckRequested()).toBe(true)
    window.history.replaceState({}, '', '/?mobxSettings=0')
    layer.initializeSettingsDataLayer(stored('0'))
    expect(layer.settingsDataLayer()).toBe('pool')
    expect(layer.settingsCheckRequested()).toBe(true)
  })
})
