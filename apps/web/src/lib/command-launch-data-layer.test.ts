import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('defaults off and latches the command reader and diagnostic choice once', async () => {
  vi.stubGlobal('location', { search: '' }); vi.resetModules()
  const off = await import('./command-launch-data-layer')
  expect(off.commandLaunchDataLayer()).toBe('legacy')
  location.search = '?mobxCommands=1&mobxCommandsCheck=1'
  off.initializeCommandLaunchDataLayer()
  expect(off.commandLaunchDataLayer()).toBe('legacy')
  expect(off.commandLaunchCheckRequested()).toBe(false)
  vi.resetModules()
  const on = await import('./command-launch-data-layer')
  expect(on.commandLaunchDataLayer()).toBe('pool')
  expect(on.commandLaunchCheckRequested()).toBe(true)
  location.search = '?mobxCommands=0'
  on.initializeCommandLaunchDataLayer()
  expect(on.commandLaunchDataLayer()).toBe('pool')
})
