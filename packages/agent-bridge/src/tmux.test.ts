import { describe, expect, it } from 'vitest'
import { isTmuxAvailable, newSessionArgs, shellQuote, tmuxConfigCommands } from './tmux'

describe('tmux command builders', () => {
  it('shell-quotes args safely', () => {
    expect(shellQuote(`a b`)).toBe(`'a b'`)
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('builds a new-session arg vector with geometry + cwd + inner command', () => {
    expect(newSessionArgs('podium-x', 80, 24, '/p', 'claude --resume t9')).toEqual([
      '-L',
      'podium-x',
      'new-session',
      '-d',
      '-s',
      'main',
      '-x',
      '80',
      '-y',
      '24',
      '-c',
      '/p',
      'claude --resume t9',
    ])
  })

  it('config commands include the input-fidelity + title settings', () => {
    const cmds = tmuxConfigCommands('podium-x')
    const flat = cmds.map((c) => c.join(' '))
    expect(flat).toContain('-L podium-x set -g prefix None')
    expect(flat).toContain('-L podium-x set -sg escape-time 0')
    expect(flat).toContain(`-L podium-x set -g set-titles-string #{pane_title}`)
    expect(flat).toContain('-L podium-x set -g extended-keys on')
  })

  it('isTmuxAvailable returns a boolean', () => {
    expect(typeof isTmuxAvailable()).toBe('boolean')
  })
})
