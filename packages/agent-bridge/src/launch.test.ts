import { describe, expect, it } from 'vitest'
import { resolveCursorBin } from './cursor/cli.js'
import { agentLaunchCommand, agentSupportsInitialPrompt } from './launch'
import { resolveOpencodeBin } from './opencode/cli.js'

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
    ).toEqual({
      cmd: 'claude',
      args: ['--resume', 'abc'],
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
      expect(
        agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: 'do the thing' }),
      ).toEqual({
        cmd: 'claude',
        args: ['do the thing'],
        cwd: '/w',
      })
    })

    it('places the prompt LAST, after model/option args (claude-code)', () => {
      expect(
        agentLaunchCommand('claude-code', { cwd: '/w', model: 'opus', initialPrompt: 'fix login' }),
      ).toEqual({
        cmd: 'claude',
        args: ['--model', 'opus', 'fix login'],
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
        prompt,
      ])
    })

    it('ignores a blank/whitespace-only prompt (no empty arg)', () => {
      expect(agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: '   ' }).args).toEqual(
        [],
      )
      expect(agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: '' }).args).toEqual([])
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

  describe('machine-authored instruction channels', () => {
    const instructions = [{ source: 'podium:workflow', content: 'Follow the pinned workflow.' }]

    it('uses Claude system prompt without changing the user prompt token', () => {
      expect(
        agentLaunchCommand('claude-code', { cwd: '/w', instructions, initialPrompt: 'fix it' }),
      ).toEqual({
        cmd: 'claude',
        args: ['--append-system-prompt', 'Follow the pinned workflow.', 'fix it'],
        cwd: '/w',
      })
    })

    it('uses Codex developer instructions', () => {
      expect(agentLaunchCommand('codex', { cwd: '/w', instructions }).args).toEqual([
        '-c',
        'developer_instructions="Follow the pinned workflow."',
      ])
    })

    it('uses Grok rules', () => {
      expect(agentLaunchCommand('grok', { cwd: '/w', instructions }).args).toEqual([
        '--rules',
        'Follow the pinned workflow.',
      ])
    })

    it('uses OpenCode inline config plus a daemon-materialized instruction file', () => {
      const spec = agentLaunchCommand('opencode', {
        cwd: '/w',
        runtimeDir: '/runtime/session',
        instructions,
        env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask"}}' },
      })
      expect(JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
        permission: { edit: 'ask' },
        instructions: ['/runtime/session/podium-instructions.md'],
      })
      expect(spec.files).toEqual([
        {
          path: '/runtime/session/podium-instructions.md',
          contents: 'Follow the pinned workflow.',
        },
      ])
    })

    it('uses a per-session Cursor rule plugin', () => {
      const spec = agentLaunchCommand('cursor', {
        cwd: '/w',
        runtimeDir: '/runtime/session',
        instructions,
      })
      expect(spec.args).toEqual(['--plugin-dir', '/runtime/session'])
      expect(spec.files?.map((file) => file.path)).toEqual([
        '/runtime/session/.cursor-plugin/plugin.json',
        '/runtime/session/rules/podium-session-context.mdc',
      ])
      expect(spec.files?.[1]?.contents).toContain('alwaysApply: true')
      expect(spec.files?.[1]?.contents).toContain('Follow the pinned workflow.')
    })
  })
  describe('effort (reasoning-effort flag, mapped per CLI)', () => {
    it('claude-code takes --effort, after --model', () => {
      expect(
        agentLaunchCommand('claude-code', { cwd: '/w', model: 'opus', effort: 'high' }).args,
      ).toEqual(['--model', 'opus', '--effort', 'high'])
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
      expect(
        agentLaunchCommand('claude-code', { cwd: '/w', model: 'auto', effort: 'auto' }).args,
      ).toEqual([])
      expect(
        agentLaunchCommand('codex', { cwd: '/w', model: 'auto', effort: 'auto' }).args,
      ).toEqual([])
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

  it('on Windows falls back to COMSPEC, then cmd.exe (SHELL is normally unset there)', () => {
    const realPlatform = process.platform
    const prevShell = process.env.SHELL
    const prevComspec = process.env.COMSPEC
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    delete process.env.SHELL
    try {
      process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
      expect(agentLaunchCommand('shell', { cwd: 'C:\\w' }).cmd).toBe(
        'C:\\Windows\\System32\\cmd.exe',
      )
      delete process.env.COMSPEC
      expect(agentLaunchCommand('shell', { cwd: 'C:\\w' }).cmd).toBe('cmd.exe')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
      if (prevShell === undefined) delete process.env.SHELL
      else process.env.SHELL = prevShell
      if (prevComspec === undefined) delete process.env.COMSPEC
      else process.env.COMSPEC = prevComspec
    }
  })
})
