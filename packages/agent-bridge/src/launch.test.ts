import { describe, expect, it } from 'vitest'
import { agentLaunchCommand, agentSupportsInitialPrompt, ISSUE_SYSTEM_POINTER } from './launch'
import { resolveCursorBin } from './cursor/cli.js'
import { resolveOpencodeBin } from './opencode/cli.js'

describe('agentLaunchCommand', () => {
  it('spawns claude fresh', () => {
    expect(agentLaunchCommand('claude-code', { cwd: '/proj' })).toEqual({
      cmd: 'claude',
      args: ['--append-system-prompt', ISSUE_SYSTEM_POINTER],
      cwd: '/proj',
    })
  })

  it('resumes claude by session id', () => {
    expect(
      agentLaunchCommand('claude-code', {
        cwd: '/proj',
        resume: { kind: 'claude-session', value: 'abc' },
      }),
    ).toEqual({
      cmd: 'claude',
      args: ['--resume', 'abc', '--append-system-prompt', ISSUE_SYSTEM_POINTER],
      cwd: '/proj',
    })
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

  it('spawns opencode fresh with a resolved binary path', () => {
    expect(agentLaunchCommand('opencode', { cwd: '/w' })).toEqual({
      cmd: resolveOpencodeBin(),
      args: [],
      cwd: '/w',
    })
  })

  it('resumes opencode by session id', () => {
    expect(
      agentLaunchCommand('opencode', {
        cwd: '/w',
        resume: { kind: 'opencode-session', value: 'ses_abc' },
      }),
    ).toEqual({ cmd: resolveOpencodeBin(), args: ['--session', 'ses_abc'], cwd: '/w' })
  })

  it('passes model override to opencode', () => {
    expect(agentLaunchCommand('opencode', { cwd: '/w', model: 'openai/gpt-5.5' })).toEqual({
      cmd: resolveOpencodeBin(),
      args: ['-m', 'openai/gpt-5.5'],
      cwd: '/w',
    })
  })

  it('spawns cursor fresh with a resolved binary path', () => {
    expect(agentLaunchCommand('cursor', { cwd: '/w' })).toEqual({
      cmd: resolveCursorBin(),
      args: [],
      cwd: '/w',
    })
  })

  it('resumes cursor by chat id', () => {
    expect(
      agentLaunchCommand('cursor', {
        cwd: '/w',
        resume: { kind: 'cursor-chat', value: 'chat-9' },
      }),
    ).toEqual({ cmd: resolveCursorBin(), args: ['--resume', 'chat-9'], cwd: '/w' })
  })

  it('passes model override to cursor', () => {
    expect(agentLaunchCommand('cursor', { cwd: '/w', model: 'composer-2.5' })).toEqual({
      cmd: resolveCursorBin(),
      args: ['--model', 'composer-2.5'],
      cwd: '/w',
    })
  })

  it('threads cwd through unchanged', () => {
    expect(agentLaunchCommand('claude-code', { cwd: '/a/b/c' }).cwd).toBe('/a/b/c')
  })

  describe('initialPrompt (argv injection — the robust, race-free first prompt)', () => {
    it('appends the prompt as a trailing positional arg for claude-code', () => {
      expect(agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: 'do the thing' })).toEqual(
        {
          cmd: 'claude',
          args: ['--append-system-prompt', ISSUE_SYSTEM_POINTER, 'do the thing'],
          cwd: '/w',
        },
      )
    })

    it('places the prompt LAST, after model/option args (claude-code)', () => {
      expect(
        agentLaunchCommand('claude-code', { cwd: '/w', model: 'opus', initialPrompt: 'fix login' }),
      ).toEqual({
        cmd: 'claude',
        args: ['--model', 'opus', '--append-system-prompt', ISSUE_SYSTEM_POINTER, 'fix login'],
        cwd: '/w',
      })
    })

    it('appends the prompt as a positional arg for codex and grok', () => {
      expect(agentLaunchCommand('codex', { cwd: '/w', initialPrompt: 'do X' })).toEqual({
        cmd: 'codex',
        args: ['do X'],
        cwd: '/w',
      })
      expect(agentLaunchCommand('grok', { cwd: '/w', initialPrompt: 'do X' })).toEqual({
        cmd: 'grok',
        args: ['do X'],
        cwd: '/w',
      })
    })

    it('preserves multi-line prompts as a single argv token', () => {
      const prompt = 'line one\nline two'
      expect(agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: prompt }).args).toEqual([
        '--append-system-prompt',
        ISSUE_SYSTEM_POINTER,
        prompt,
      ])
    })

    it('ignores a blank/whitespace-only prompt (no empty arg)', () => {
      expect(agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: '   ' }).args).toEqual([
        '--append-system-prompt',
        ISSUE_SYSTEM_POINTER,
      ])
      expect(agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: '' }).args).toEqual([
        '--append-system-prompt',
        ISSUE_SYSTEM_POINTER,
      ])
    })

    it('does NOT append a prompt arg for non-argv agents (opencode/cursor/shell)', () => {
      expect(agentLaunchCommand('opencode', { cwd: '/w', initialPrompt: 'x' }).args).toEqual([])
      expect(agentLaunchCommand('cursor', { cwd: '/w', initialPrompt: 'x' }).args).toEqual([])
      expect(agentLaunchCommand('shell', { cwd: '/w', initialPrompt: 'x' }).args).toEqual([])
    })

    it('agentSupportsInitialPrompt: argv-capable agents only', () => {
      expect(agentSupportsInitialPrompt('claude-code')).toBe(true)
      expect(agentSupportsInitialPrompt('codex')).toBe(true)
      expect(agentSupportsInitialPrompt('grok')).toBe(true)
      expect(agentSupportsInitialPrompt('opencode')).toBe(false)
      expect(agentSupportsInitialPrompt('cursor')).toBe(false)
      expect(agentSupportsInitialPrompt('shell')).toBe(false)
    })
  })

  describe('issue system-prompt pointer (claude-code only)', () => {
    it('claude-code launch appends the issue system pointer', () => {
      const spec = agentLaunchCommand('claude-code', { cwd: '/x' })
      const i = spec.args.indexOf('--append-system-prompt')
      expect(i).toBeGreaterThanOrEqual(0)
      expect(spec.args[i + 1]).toBe(ISSUE_SYSTEM_POINTER)
    })

    it('non-claude agents do not get --append-system-prompt', () => {
      for (const kind of ['codex', 'grok'] as const) {
        expect(agentLaunchCommand(kind, { cwd: '/x' }).args).not.toContain('--append-system-prompt')
      }
    })
  })

  describe('effort (reasoning-effort flag, mapped per CLI)', () => {
    it('claude-code takes --effort, after --model', () => {
      expect(
        agentLaunchCommand('claude-code', { cwd: '/w', model: 'opus', effort: 'high' }).args,
      ).toEqual(['--model', 'opus', '--effort', 'high', '--append-system-prompt', ISSUE_SYSTEM_POINTER])
    })

    it('grok takes --effort', () => {
      expect(agentLaunchCommand('grok', { cwd: '/w', effort: 'xhigh' }).args).toEqual([
        '--effort',
        'xhigh',
      ])
    })

    it('codex maps effort to a reasoning-effort config override', () => {
      expect(agentLaunchCommand('codex', { cwd: '/w', effort: 'high' }).args).toEqual([
        '-c',
        'model_reasoning_effort=high',
      ])
    })

    it('opencode maps effort to --variant', () => {
      expect(agentLaunchCommand('opencode', { cwd: '/w', effort: 'high' }).args).toEqual([
        '--variant',
        'high',
      ])
    })

    it('cursor has no effort flag — effort is dropped', () => {
      expect(agentLaunchCommand('cursor', { cwd: '/w', effort: 'high' }).args).toEqual([])
    })

    it("'auto' (the sentinel) emits no model or effort flag", () => {
      expect(agentLaunchCommand('claude-code', { cwd: '/w', model: 'auto', effort: 'auto' }).args)
        .toEqual(['--append-system-prompt', ISSUE_SYSTEM_POINTER])
      expect(agentLaunchCommand('codex', { cwd: '/w', model: 'auto', effort: 'auto' }).args).toEqual(
        [],
      )
    })
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
