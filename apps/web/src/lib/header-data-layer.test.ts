import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, describe, expect, it, vi } from 'vitest'

const stored = (value: string | null) => ({
  get: vi.fn((key: string) => key === MOBX_SIDEBAR_KEY ? value : null),
})

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })
describe('header startup switch', () => {
  it.each([
    ['', '1', 'pool'],
    ['?mobxHeader=0', '1', 'legacy'],
    ['?mobxHeader=1', '0', 'pool'],
  ] as const)('uses the shared MobX pilot setting with URL precedence: %s', async (query, setting, expected) => {
    history.replaceState(null, '', `/${query}`)
    const mode = await import('./header-data-layer')
    mode.initializeHeaderDataLayer(stored(setting))
    expect(mode.headerDataLayer()).toBe(expected)
    expect(mode.headerCheckRequested()).toBe(false)
    history.replaceState(null, '', expected === 'pool' ? '/?mobxHeader=0&mobxHeaderCheck=1' : '/?mobxHeader=1&mobxHeaderCheck=1')
    mode.initializeHeaderDataLayer(stored(setting === '1' ? '0' : '1'))
    expect(mode.headerDataLayer()).toBe(expected)
    expect(mode.headerCheckRequested()).toBe(false)
  })

  it.each(['', '?mobxHeader=0', '?mobxHeaderCheck=1', '?mobxHeader=garbage'])('defaults off for %s', async (query) => {
    history.replaceState(null, '', `/${query}`)
    const mode = await import('./header-data-layer')
    mode.initializeHeaderDataLayer(stored(null))
    expect(mode.headerDataLayer()).toBe('legacy')
    expect(mode.headerCheckRequested()).toBe(false)
  })
  it('freezes the pool and diagnostic choices before mount', async () => {
    history.replaceState(null, '', '/?mobxHeader=1&mobxHeaderCheck=1')
    const mode = await import('./header-data-layer')
    mode.initializeHeaderDataLayer(stored(null))
    expect(mode.headerDataLayer()).toBe('pool')
    expect(mode.headerCheckRequested()).toBe(true)
    history.replaceState(null, '', '/')
    mode.initializeHeaderDataLayer(stored('0'))
    expect(mode.headerDataLayer()).toBe('pool')
    expect(mode.headerCheckRequested()).toBe(true)
  })
})
