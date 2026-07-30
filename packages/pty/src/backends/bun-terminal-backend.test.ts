import { describe, expect, it } from 'vitest'
import { minTerminalBunVersion, terminalProbeCommand } from './bun-terminal-backend.js'

describe('terminalProbeCommand', () => {
  it('probes with `true` on POSIX', () => {
    expect(terminalProbeCommand('linux')).toEqual(['true'])
    expect(terminalProbeCommand('darwin')).toEqual(['true'])
  })
  it('probes with cmd.exe on Windows (`true` does not exist there)', () => {
    expect(terminalProbeCommand('win32')).toEqual(['cmd.exe', '/d', '/c', 'exit'])
  })
})

describe('minTerminalBunVersion', () => {
  it('is 1.3.5 on POSIX (Bun.Terminal introduction)', () => {
    expect(minTerminalBunVersion('linux')).toBe('1.3.5')
  })
  it('is 1.3.14 on Windows (ConPTY support landed there)', () => {
    expect(minTerminalBunVersion('win32')).toBe('1.3.14')
  })
})
