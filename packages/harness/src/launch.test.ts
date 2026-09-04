import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { resolveCursorBin } from './cursor/cli.js'
import { agentLaunchCommand, agentSupportsInitialPrompt } from './launch'
import { resolveOpencodeBin } from './opencode/cli.js'
import { opencodeSessionDbPath } from './opencode/db.js'

const CODEX_NETWORK_ARGS = ['-c', 'sandbox_workspace_write.network_access=true']
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
      args: CODEX_NETWORK_ARGS,
      cwd: '/w',
    })
  })

  it('resumes codex by thread id', () => {
    expect(
      agentLaunchCommand('codex', { cwd: '/w', resume: { kind: 'codex-thread', value: 't9' } }),
    ).toEqual({
      cmd: 'codex',
      args: ['resume', '-C', '/w', 't9', ...CODEX_NETWORK_ARGS],
      cwd: '/w',
    })
  })

  it('spawns grok fresh', () => {
    expect(agentLaunchCommand('grok', { cwd: '/w' })).toEqual({
      cmd: 'grok',
      args: [],
      cwd: '/w',
    })
  })

  it('binds imported hook compatibility ids for Podium Grok sessions', () => {
    expect(
      agentLaunchCommand('grok', {
        cwd: '/w',
        podiumSessionId: asSessionId('podium-session-1'),
      }).env,
    ).toEqual({
      HARNESS_TERMINAL_ID: 'podium-session-1',
      CLAUDE_HARNESS_ID: 'podium-session-1',
    })
  })

  it('resumes grok by session id', () => {
    expect(
      agentLaunchCommand('grok', { cwd: '/w', resume: { kind: 'grok-session', value: 'g9' } }),
    ).toEqual({ cmd: 'grok', args: ['--resume', 'g9'], cwd: '/w' })
  })

  // A bare `grok` writes no session directory until its first turn, so naming the
  // new session is what gives an idle one a transcript at all. [POD-386]
  it('names the new grok session so it exists from boot', () => {
    expect(agentLaunchCommand('grok', { cwd: '/w', newSessionId: 'g-new' }).args).toEqual([
      '--session-id',
      'g-new',
    ])
  })

  // `--session-id` is new-session only: with --resume grok rejects it unless
  // --fork-session, which would fork the conversation instead of continuing it.
  it('drops the new-session id when resuming grok', () => {
    expect(
      agentLaunchCommand('grok', {
        cwd: '/w',
        resume: { kind: 'grok-session', value: 'g9' },
        newSessionId: 'g-new',
      }).args,
    ).toEqual(['--resume', 'g9'])
  })

  it.each([
    'grok-4.5',
    'grok-composer-2.5-fast',
  ])('passes the supported Grok model override %s', (model) => {
    expect(agentLaunchCommand('grok', { cwd: '/w', model })).toEqual({
      cmd: 'grok',
      args: ['--model', model],
      cwd: '/w',
    })
  })

  it('spawns opencode fresh with its provider command', () => {
    expect(agentLaunchCommand('opencode', { cwd: '/w' })).toEqual({
      cmd: resolveOpencodeBin(),
      args: [],
      cwd: '/w',
    })
  })

  it('selects a session-owned OpenCode store for a fresh terminal', () => {
    const spec = agentLaunchCommand('opencode', {
      cwd: '/w',
      homeDir: '/instance/home',
      podiumSessionId: asSessionId('podium-opencode-a'),
    })
    expect(spec.env).toEqual({
      OPENCODE_DB: opencodeSessionDbPath('/instance/home', 'podium-opencode-a'),
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

  it('spawns cursor fresh with its provider command', () => {
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
        args: ['--', 'do the thing'],
        cwd: '/w',
      })
    })

    it('places the prompt LAST, after model/option args (claude-code)', () => {
      expect(
        agentLaunchCommand('claude-code', { cwd: '/w', model: 'opus', initialPrompt: 'fix login' }),
      ).toEqual({
        cmd: 'claude',
        args: ['--model', 'opus', '--', 'fix login'],
        cwd: '/w',
      })
    })

    it('appends the prompt as a positional arg for codex and grok', () => {
      expect(agentLaunchCommand('codex', { cwd: '/w', initialPrompt: 'do X' })).toEqual({
        cmd: 'codex',
        args: [...CODEX_NETWORK_ARGS, '--', 'do X'],
        cwd: '/w',
      })
      expect(agentLaunchCommand('grok', { cwd: '/w', initialPrompt: 'do X' })).toEqual({
        cmd: 'grok',
        args: ['--', 'do X'],
        cwd: '/w',
      })
    })

    it('preserves multi-line prompts as a single argv token', () => {
      const prompt = 'line one\nline two'
      expect(agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: prompt }).args).toEqual([
        '--',
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

    // POD-1317: a description that opens with a bullet ("- remove …") is a
    // PROMPT, not a flag. Claude 2.1.234 without the `--` boundary printed
    // `error: unknown option '- remove …'` and exited 1 in ~1s — two output
    // frames, no conversation, no transcript, nothing for the user to resume.
    // clap (codex/grok) fails the same way with "unexpected argument", and its
    // own tip is this fix. Every argv-capable agent is asserted here so a new
    // manifest cannot reintroduce the bare-token form.
    describe('option-like prompts (POD-1317)', () => {
      const OPTION_LIKE = [
        '- remove the dead code path\n- then run the tests',
        '--help',
        '-p',
        '--model=opus is what broke it',
        '-',
      ]

      for (const prompt of OPTION_LIKE) {
        it(`delivers ${JSON.stringify(prompt)} as a positional, never an option`, () => {
          for (const kind of ['claude-code', 'codex', 'grok'] as const) {
            const args = agentLaunchCommand(kind, { cwd: '/w', initialPrompt: prompt }).args
            // The prompt survives byte-for-byte as the FINAL token...
            expect(args.at(-1)).toBe(prompt)
            // ...and the token immediately before it is the `--` boundary, so the
            // CLI's parser stops reading options before it ever sees the prompt.
            expect(args.at(-2)).toBe('--')
          }
        })
      }

      it('keeps the boundary last even with resume + model + effort + instructions', () => {
        const args = agentLaunchCommand('claude-code', {
          cwd: '/w',
          resume: { kind: 'claude-session', value: 'abc' },
          model: 'opus',
          effort: 'high',
          instructions: [{ source: 'podium:workflow', content: 'Follow the pinned workflow.' }],
          initialPrompt: '- remove the dead code path',
        }).args
        expect(args).toEqual([
          '--resume',
          'abc',
          '--model',
          'opus',
          '--effort',
          'high',
          '--append-system-prompt',
          'Follow the pinned workflow.',
          '--',
          '- remove the dead code path',
        ])
      })

      it('emits NO `--` when there is no prompt (a bare launch stays bare)', () => {
        for (const kind of ['claude-code', 'codex', 'grok'] as const) {
          expect(agentLaunchCommand(kind, { cwd: '/w' }).args).not.toContain('--')
          expect(agentLaunchCommand(kind, { cwd: '/w', initialPrompt: '  ' }).args).not.toContain(
            '--',
          )
        }
      })

      it('passes the prompt UNTRIMMED — only the emptiness test trims', () => {
        const prompt = '  - keep my indentation  '
        expect(
          agentLaunchCommand('claude-code', { cwd: '/w', initialPrompt: prompt }).args,
        ).toEqual(['--', prompt])
      })
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
        args: ['--append-system-prompt', 'Follow the pinned workflow.', '--', 'fix it'],
        cwd: '/w',
      })
    })

    it('uses Codex developer instructions', () => {
      expect(agentLaunchCommand('codex', { cwd: '/w', instructions }).args).toEqual([
        '-c',
        'developer_instructions="Follow the pinned workflow."',
        ...CODEX_NETWORK_ARGS,
      ])
    })

    it('never places the stable Podium row id into Codex developer context', () => {
      const sessionId = 'f439e012-7cd1-4d39-a07e-5843caf35f0c'
      expect(
        agentLaunchCommand('codex', { cwd: '/w', podiumSessionId: asSessionId(sessionId) }).args,
      ).toEqual(CODEX_NETWORK_ARGS)
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
        ...CODEX_NETWORK_ARGS,
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
      ).toEqual(CODEX_NETWORK_ARGS)
    })
  })

  it('spawns an interactive shell in the worktree cwd', () => {
    expect(agentLaunchCommand('shell', { cwd: '/w', env: { SHELL: '/bin/zsh' } })).toEqual({
      cmd: '/bin/zsh',
      args: [],
      cwd: '/w',
    })
  })

  it('falls back to bash when SHELL is unset', () => {
    expect(agentLaunchCommand('shell', { cwd: '/w', env: {} }).cmd).toBe('/bin/bash')
  })

  it('on Windows falls back to COMSPEC, then cmd.exe (SHELL is normally unset there)', () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(
        agentLaunchCommand('shell', {
          cwd: 'C:\\w',
          env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
        }).cmd,
      ).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(agentLaunchCommand('shell', { cwd: 'C:\\w', env: {} }).cmd).toBe('cmd.exe')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })
})
