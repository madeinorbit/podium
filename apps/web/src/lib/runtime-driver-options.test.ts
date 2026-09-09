import { describe, expect, it } from 'vitest'
import { runtimeDriverLabel, terminalRuntimeDriver } from './runtime-driver-options.js'

describe('runtime driver labels', () => {
  it('distinguishes both OpenCode headless generations', () => {
    expect(runtimeDriverLabel('opencode-server')).toBe('OpenCode 1 (headless)')
    expect(runtimeDriverLabel('opencode2-server')).toBe('OpenCode 2 (headless)')
    expect(runtimeDriverLabel('codex-app-server')).toBe('codex-app-server')
  })
  it('selects the reported terminal driver for the requested harness', () => {
    const machine = {
      inventory: {
        runtimeDrivers: [
          { harness: 'claude-code', id: 'claude-pty', family: 'terminal' },
          { harness: 'opencode', id: 'generic-pty', family: 'terminal' },
        ],
      },
    } as unknown as Parameters<typeof terminalRuntimeDriver>[0]
    expect(terminalRuntimeDriver(machine, 'claude-code')).toMatchObject({
      id: 'claude-pty',
      family: 'terminal',
    })
    expect(terminalRuntimeDriver(machine, 'codex')).toBeUndefined()
  })
})
