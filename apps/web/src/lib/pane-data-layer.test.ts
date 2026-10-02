import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })
describe('pane startup switch', () => {
  it.each(['', '?mobxPane=0', '?mobxPane=garbage'])('defaults off for %s', async query => {
    history.replaceState(null, '', `/${query}`)
    const mode = await import('./pane-data-layer')
    expect(mode.paneDataLayer()).toBe('legacy')
  })
  it('reads the pane choice only once per app load', async () => {
    history.replaceState(null, '', '/?mobxPane=1')
    const mode = await import('./pane-data-layer')
    expect(mode.paneDataLayer()).toBe('pool')
    history.replaceState(null, '', '/?mobxPane=0')
    mode.initializePaneDataLayer()
    expect(mode.paneDataLayer()).toBe('pool')
  })
})
