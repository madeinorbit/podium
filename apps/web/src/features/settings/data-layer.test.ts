import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { window.history.replaceState({}, '', '/'); vi.resetModules() })

describe('settings startup choice', () => {
  it('defaults off and does not enable checks in legacy mode', async () => {
    window.history.replaceState({}, '', '/?mobxSettingsCheck=1')
    vi.resetModules()
    const layer = await import('./data-layer')
    expect(layer.settingsDataLayer()).toBe('legacy')
    expect(layer.settingsCheckRequested()).toBe(false)
  })

  it('latches the initial choice across navigation and principal initialization', async () => {
    window.history.replaceState({}, '', '/?mobxSettings=1&mobxSettingsCheck=1')
    vi.resetModules()
    const layer = await import('./data-layer')
    expect(layer.settingsDataLayer()).toBe('pool')
    expect(layer.settingsCheckRequested()).toBe(true)
    window.history.replaceState({}, '', '/?mobxSettings=0')
    layer.initializeSettingsDataLayer()
    expect(layer.settingsDataLayer()).toBe('pool')
    expect(layer.settingsCheckRequested()).toBe(true)
  })
})
