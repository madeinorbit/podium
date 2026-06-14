import { describe, expect, it } from 'vitest'
import { agentLaunchCommand } from './launch'

describe('agentLaunchCommand', () => {
  it('spawns claude fresh', () => {
    expect(agentLaunchCommand('claude-code', { cwd: '/proj' })).toEqual({
      cmd: 'claude',
      args: [],
      cwd: '/proj',
    })
  })

  it('resumes claude by session id', () => {
    expect(
      agentLaunchCommand('claude-code', {
        cwd: '/proj',
        resume: { kind: 'claude-session', value: 'abc' },
      }),
    ).toEqual({ cmd: 'claude', args: ['--resume', 'abc'], cwd: '/proj' })
  })

  it('spawns codex fresh', () => {
    expect(agentLaunchCommand('codex', { cwd: '/w' })).toEqual({
      cmd: 'codex',
      args: [],
      cwd: '/w',
    })
  })

  it('resumes codex by thread id', () => {
    expect(
      agentLaunchCommand('codex', { cwd: '/w', resume: { kind: 'codex-thread', value: 't9' } }),
    ).toEqual({ cmd: 'codex', args: ['resume', 't9'], cwd: '/w' })
  })

  it('spawns grok fresh', () => {
    expect(agentLaunchCommand('grok', { cwd: '/w' })).toEqual({
      cmd: 'grok',
      args: [],
      cwd: '/w',
    })
  })

  it('resumes grok by session id', () => {
    expect(
      agentLaunchCommand('grok', { cwd: '/w', resume: { kind: 'grok-session', value: 'g9' } }),
    ).toEqual({ cmd: 'grok', args: ['--resume', 'g9'], cwd: '/w' })
  })

  it('passes model override to grok', () => {
    expect(agentLaunchCommand('grok', { cwd: '/w', model: 'grok-code-fast-1' })).toEqual({
      cmd: 'grok',
      args: ['--model', 'grok-code-fast-1'],
      cwd: '/w',
    })
  })

  it('threads cwd through unchanged', () => {
    expect(agentLaunchCommand('claude-code', { cwd: '/a/b/c' }).cwd).toBe('/a/b/c')
  })

  it('spawns an interactive shell in the worktree cwd', () => {
    const prev = process.env.SHELL
    process.env.SHELL = '/bin/zsh'
    try {
      expect(agentLaunchCommand('shell', { cwd: '/w' })).toEqual({
        cmd: '/bin/zsh',
        args: [],
        cwd: '/w',
      })
    } finally {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
    }
  })

  it('falls back to bash when SHELL is unset', () => {
    const prev = process.env.SHELL
    delete process.env.SHELL
    try {
      expect(agentLaunchCommand('shell', { cwd: '/w' }).cmd).toBe('/bin/bash')
    } finally {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
    }
  })
})
