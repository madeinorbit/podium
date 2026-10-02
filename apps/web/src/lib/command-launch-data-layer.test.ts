import { afterEach, expect, it, vi } from 'vitest'
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('defaults off and latches the command reader and diagnostic choice once', async () => {
  for (const [query, preference, expected, check] of [
    ['', null, 'legacy', false],
    ['', '1', 'pool', false],
    ['?mobxCommands=1&mobxCommandsCheck=1', '0', 'pool', true],
    ['?mobxCommands=0&mobxCommandsCheck=1', '1', 'legacy', false],
    ['?mobxCommands=true', '0', 'pool', false],
    ['?mobxCommands=false', '1', 'legacy', false],
    ['?mobxCommands=invalid', '1', 'pool', false],
  ] as const) {
    vi.stubGlobal('location', { search: query }); vi.resetModules()
    const mode = await import('./command-launch-data-layer')
    const get = vi.fn((key: string) => key === MOBX_SIDEBAR_KEY ? preference : null)
    expect(mode.commandLaunchDataLayer()).toBe('legacy')
    mode.initializeCommandLaunchDataLayer({ get })
    expect(mode.commandLaunchDataLayer(), query).toBe(expected)
    expect(mode.commandLaunchCheckRequested(), query).toBe(check)
    const reads = get.mock.calls.length
    if (!query || query.includes('invalid')) expect(get).toHaveBeenCalledExactlyOnceWith(MOBX_SIDEBAR_KEY)
    else expect(get).not.toHaveBeenCalled()
    location.search = expected === 'legacy' ? '?mobxCommands=1&mobxCommandsCheck=1' : '?mobxCommands=0'
    get.mockImplementation(() => expected === 'legacy' ? '1' : '0')
    mode.initializeCommandLaunchDataLayer({ get })
    expect(mode.commandLaunchDataLayer()).toBe(expected)
    expect(mode.commandLaunchCheckRequested()).toBe(check)
    expect(get).toHaveBeenCalledTimes(reads)
  }
})
