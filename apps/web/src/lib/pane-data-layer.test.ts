import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'

const stored = (value: string | null) => ({ get: (key: string) => key === MOBX_SIDEBAR_KEY ? value : null })

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })
describe('pane startup switch', () => {
  it.each(['', '?mobxPane=0', '?mobxPane=garbage'])('defaults off for %s', async query => {
    history.replaceState(null, '', `/${query}`)
    const mode = await import('./pane-data-layer')
    mode.initializePaneDataLayer(stored(null))
    expect(mode.paneDataLayer()).toBe('legacy')
  })
  it('reads the pane choice only once per app load', async () => {
    history.replaceState(null, '', '/?mobxPane=1')
    const mode = await import('./pane-data-layer')
    mode.initializePaneDataLayer(stored(null))
    expect(mode.paneDataLayer()).toBe('pool')
    history.replaceState(null, '', '/?mobxPane=0')
    mode.initializePaneDataLayer(stored('0'))
    expect(mode.paneDataLayer()).toBe('pool')
  })
  it.each([
    ['', '1', 'pool'],
    ['?mobxPane=0', '1', 'legacy'],
    ['?mobxPane=1', '0', 'pool'],
  ] as const)('uses the shared pilot with the pane URL override: %s', async (query, setting, expected) => {
    history.replaceState(null, '', `/${query}`)
    const mode = await import('./pane-data-layer')
    mode.initializePaneDataLayer(stored(setting))
    expect(mode.paneDataLayer()).toBe(expected)
    history.replaceState(null, '', expected === 'pool' ? '/?mobxPane=0' : '/?mobxPane=1')
    mode.initializePaneDataLayer(stored(setting === '1' ? '0' : '1'))
    expect(mode.paneDataLayer()).toBe(expected)
  })
})
