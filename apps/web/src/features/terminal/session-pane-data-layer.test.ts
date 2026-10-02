import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { history.replaceState(null, '', '/'); vi.resetModules() })
it('defaults off, follows the shared pilot, allows a screen override, and reads startup once', async () => {
  for (const [query, pilot, expected] of [['', null, 'legacy'], ['', '1', 'pool'], ['?mobxSessionPane=0', '1', 'legacy'], ['?mobxSessionPane=1', null, 'pool']] as const) {
    vi.resetModules(); history.replaceState(null, '', `/${query}`)
    const module = await import('./session-pane-data-layer')
    const get = vi.fn((key: string) => key === MOBX_SIDEBAR_KEY ? pilot : null)
    expect(module.sessionPaneDataLayer()).toBe('legacy')
    module.initializeSessionPaneDataLayer({ get })
    expect(module.sessionPaneDataLayer()).toBe(expected)
    const reads = get.mock.calls.length
    history.replaceState(null, '', '/?mobxSessionPane=1&mobxSessionPaneCheck=1')
    module.initializeSessionPaneDataLayer({ get: () => '1' })
    expect(module.sessionPaneDataLayer()).toBe(expected)
    expect(get.mock.calls.length).toBe(reads)
    expect(module.sessionPaneCheckRequested()).toBe(false)
  }
})
