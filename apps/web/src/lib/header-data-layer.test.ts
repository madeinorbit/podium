import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })
describe('header startup switch', () => {
  it.each(['', '?mobxHeader=0', '?mobxHeaderCheck=1', '?mobxHeader=garbage'])('defaults off for %s', async (query) => {
    history.replaceState(null, '', `/${query}`)
    const mode = await import('./header-data-layer')
    expect(mode.headerDataLayer()).toBe('legacy')
    expect(mode.headerCheckRequested()).toBe(false)
  })
  it('freezes the pool and diagnostic choices before mount', async () => {
    history.replaceState(null, '', '/?mobxHeader=1&mobxHeaderCheck=1')
    const mode = await import('./header-data-layer')
    expect(mode.headerDataLayer()).toBe('pool')
    expect(mode.headerCheckRequested()).toBe(true)
    history.replaceState(null, '', '/')
    mode.initializeHeaderDataLayer()
    expect(mode.headerDataLayer()).toBe('pool')
    expect(mode.headerCheckRequested()).toBe(true)
  })
})
