import { describe, expect, it, vi } from 'vitest'

const rendererImported = vi.hoisted(() => vi.fn())

vi.mock('@xterm/xterm', () => {
  rendererImported('@xterm/xterm')
  return {}
})
vi.mock('@xterm/addon-fit', () => {
  rendererImported('@xterm/addon-fit')
  return {}
})
vi.mock('@xterm/addon-webgl', () => {
  rendererImported('@xterm/addon-webgl')
  return {}
})

describe('@podium/terminal-client-react light entry', () => {
  it('does not evaluate xterm or its renderer addons', async () => {
    const entry = await import('@podium/terminal-client-react')

    expect(entry.useTerminalSession).toBeTypeOf('function')
    expect(entry.preloadTerminalRuntime).toBeTypeOf('function')
    expect(rendererImported).not.toHaveBeenCalled()
  })
})
