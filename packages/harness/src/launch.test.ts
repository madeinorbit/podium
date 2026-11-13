import { join } from 'node:path'
import type { AgentKind } from '@podium/model'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { opencodeSessionDbPath } from './adapters/opencode/paths.js'
import { testHarnessContext, testLaunchPosture } from './driver/testing/harness-context.js'
import {
  agentLaunchCommand,
  agentSupportsInitialPrompt,
  type LaunchSpec,
  windowsDefaultShell,
} from './launch'

/** The installation every harness launch below is bound to (POD-6536): argv[0]
 *  is the context's executable, never the CLI's bare name. */
const exe = (kind: string): string => `/opt/podium-test/bin/${kind}`
/** The session context a harness launch takes; the shell takes none. */
const ctx = (kind: AgentKind, home?: string) => {
  if (kind === 'shell') return {}
  const harnessContext = testHarnessContext({ kind, ...(home ? { home } : {}) })
  const { context: _context, ...posture } = testLaunchPosture(harnessContext)
  return { harnessContext, posture }
}

/**
 * A launch as the argv suites below pin it: its terms are the identity (every
 * posture section is `unchangedPosture` until its harness's task), so the
 * empty env, files and terms `harnessCommand` always carries are checked here
 * and left out of the expected shapes.
 */
function plain(spec: LaunchSpec): Record<string, unknown> {
  if (!('terms' in spec)) return spec
  const { env, files, terms, ...rest } = spec
  expect(terms).toEqual({ homeEdits: [], requestedMode: null, unmet: [] })
  return {
    ...rest,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(files.length > 0 ? { files } : {}),
  }
}

/**
 * What Codex's posture section adds to every terminal launch under the default
 * posture (POD-6858 §4.8), ahead of any `--` prompt boundary. Moved to
 * posture: the loopback override used to be the builder's own; trust, the
 * update switch and the mode used to be absent.
 */
const CODEX_POSTURE_ARGS = [
  '-c',
  'projects={"/work/podium-test"={trust_level="trusted"}}',
  '-c',
  'check_for_update_on_startup=false',
  '-c',
  'sandbox_workspace_write.network_access=true',
  '--approve-for-me',
]

/** A Codex terminal launch with its terms checked, shaped like {@link plain}. */
function codexPlain(spec: LaunchSpec): Record<string, unknown> {
  if (!('terms' in spec)) throw new Error('a Codex launch always carries terms')
  const { env, files, terms, ...rest } = spec
  expect(terms).toEqual({
    homeEdits: [
      {
        kind: 'owned-file',
        file: '/home/podium-test/.codex/rules/podium.rules',
        contents:
          '# Written by Podium. Lets agents run the Podium CLI without asking.\n' +
          'prefix_rule(pattern = ["podium"], decision = "allow", justification = "Podium CLI: required for an agent to work inside Podium")\n',
        serves: 'podium-cli',
      },
    ],
    requestedMode: 'auto-review',
    unmet: [],
  })
  expect(env).toEqual({})
  expect(files).toEqual([])
  return rest
}

/**
 * What Claude's posture section adds to every terminal launch under the
 * default posture (POD-6858 §4.8), ahead of any `--` prompt boundary. Moved
 * to posture: these used to be absent from the terminal launch.
 */
const CLAUDE_POSTURE_ARGS = [
  '--permission-mode',
  'auto',
  '--allowedTools=Bash(podium *)',
  '--allowedTools=PowerShell(podium *)',
  '--allowedTools=Read(//var/podium-test/uploads/session/**)',
]

/** A Claude terminal launch with its terms checked, shaped like {@link plain}. */
function claudePlain(spec: LaunchSpec): Record<string, unknown> {
  if (!('terms' in spec)) throw new Error('a Claude launch always carries terms')
  const { env, files, terms, ...rest } = spec
  expect(terms).toEqual({
    homeEdits: [
      {
        kind: 'json-key',
        file: '/home/podium-test/.claude.json',
        path: ['projects', '/work/podium-test', 'hasTrustDialogAccepted'],
        value: true,
        serves: 'workspace-trust',
      },
    ],
    requestedMode: 'auto',
    unmet: [],
  })
  expect(env).toEqual({ CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1' })
  expect(files).toEqual([])
  return rest
}

/**
 * What OpenCode's posture section adds to every terminal launch under the
 * default posture (POD-6858 §4.8): the Podium CLI and the uploads folder in the
 * inline config's permission block. Moved to posture: `--auto`, which the
 * builder used to put first on every launch, now ends the launch's options.
 */
const OPENCODE_POSTURE_PERMISSION = {
  bash: { 'podium *': 'allow' },
  external_directory: { '/var/podium-test/uploads/session/*': 'allow' },
}

/** An OpenCode terminal launch with its terms and inline config checked,
 *  shaped like {@link plain}. */
function opencodePlain(spec: LaunchSpec): Record<string, unknown> {
  if (!('terms' in spec)) throw new Error('an OpenCode launch always carries terms')
  const { env, files, terms, ...rest } = spec
  expect(terms).toEqual({ homeEdits: [], requestedMode: 'auto', unmet: [] })
  const { OPENCODE_CONFIG_CONTENT: config, ...otherEnv } = env
  expect(JSON.parse(config ?? '{}')).toEqual({ permission: OPENCODE_POSTURE_PERMISSION })
  return {
    ...rest,
    ...(Object.keys(otherEnv).length > 0 ? { env: otherEnv } : {}),
    ...(files.length > 0 ? { files } : {}),
  }
}

describe('agentLaunchCommand', () => {
  it('spawns claude fresh', () => {
    expect(
      claudePlain(agentLaunchCommand('claude-code', { ...ctx('claude-code'), cwd: '/proj' })),
    ).toEqual({
      cmd: exe('claude-code'),
      args: CLAUDE_POSTURE_ARGS,
      cwd: '/proj',
    })
  })

  it('resumes claude by session id', () => {
    expect(
      claudePlain(
        agentLaunchCommand('claude-code', {
          ...ctx('claude-code'),
          cwd: '/proj',
          resume: { kind: 'claude-session', value: 'abc' },
        }),
      ),
    ).toEqual({
      cmd: exe('claude-code'),
      args: ['--resume', 'abc', ...CLAUDE_POSTURE_ARGS],
      cwd: '/proj',
    })
  })

  it('spawns codex fresh', () => {
    expect(codexPlain(agentLaunchCommand('codex', { ...ctx('codex'), cwd: '/w' }))).toEqual({
      cmd: exe('codex'),
      args: CODEX_POSTURE_ARGS,
      cwd: '/w',
    })
  })

  it('resumes codex by thread id', () => {
    expect(
      codexPlain(
        agentLaunchCommand('codex', {
          ...ctx('codex'),
          cwd: '/w',
          resume: { kind: 'codex-thread', value: 't9' },
        }),
      ),
    ).toEqual({
      cmd: exe('codex'),
      args: ['resume', '-C', '/w', 't9', ...CODEX_POSTURE_ARGS],
      cwd: '/w',
    })
  })

  it('spawns grok fresh', () => {
    expect(plain(agentLaunchCommand('grok', { ...ctx('grok'), cwd: '/w' }))).toEqual({
      cmd: exe('grok'),
      args: [],
      cwd: '/w',
    })
  })

  it('binds imported hook compatibility ids for Podium Grok sessions', () => {
    expect(
      agentLaunchCommand('grok', {
        ...ctx('grok'),
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
      plain(
        agentLaunchCommand('grok', {
          ...ctx('grok'),
          cwd: '/w',
          resume: { kind: 'grok-session', value: 'g9' },
        }),
      ),
    ).toEqual({ cmd: exe('grok'), args: ['--resume', 'g9'], cwd: '/w' })
  })

  // A bare `grok` writes no session directory until its first turn, so naming the
  // new session is what gives an idle one a transcript at all. [POD-386]
  it('names the new grok session so it exists from boot', () => {
    expect(
      agentLaunchCommand('grok', { ...ctx('grok'), cwd: '/w', newSessionId: 'g-new' }).args,
    ).toEqual(['--session-id', 'g-new'])
  })

  // `--session-id` is new-session only: with --resume grok rejects it unless
  // --fork-session, which would fork the conversation instead of continuing it.
  it('drops the new-session id when resuming grok', () => {
    expect(
      agentLaunchCommand('grok', {
        ...ctx('grok'),
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
    expect(plain(agentLaunchCommand('grok', { ...ctx('grok'), cwd: '/w', model }))).toEqual({
      cmd: exe('grok'),
      args: ['--model', model],
      cwd: '/w',
    })
  })

  it('spawns opencode fresh with its provider command', () => {
    expect(
      opencodePlain(agentLaunchCommand('opencode', { ...ctx('opencode'), cwd: '/w' })),
    ).toEqual({
      cmd: exe('opencode'),
      args: ['--auto'],
      cwd: '/w',
    })
  })

  it('spawns headed opencode in auto permissions mode under the default posture', () => {
    expect(agentLaunchCommand('opencode', { ...ctx('opencode'), cwd: '/w' }).args).toContain(
      '--auto',
    )
    expect(
      agentLaunchCommand('opencode', {
        ...ctx('opencode'),
        cwd: '/w',
        resume: { kind: 'opencode-session', value: 'ses_abc' },
      }).args,
    ).toContain('--auto')
    expect(
      agentLaunchCommand('opencode', { ...ctx('opencode'), cwd: '/w', model: 'openai/gpt-5.5' })
        .args,
    ).toContain('--auto')
    expect(
      agentLaunchCommand('opencode', { ...ctx('opencode'), cwd: '/w', initialPrompt: 'do work' })
        .args,
    ).toContain('--auto')
  })

  it('selects a session-owned OpenCode store for a fresh terminal', () => {
    const spec = agentLaunchCommand('opencode', {
      ...ctx('opencode', '/instance/home'),
      cwd: '/w',
      podiumSessionId: asSessionId('podium-opencode-a'),
    })
    const { OPENCODE_CONFIG_CONTENT: _posture, ...env } = spec.env ?? {}
    expect(env).toEqual({
      OPENCODE_DB: opencodeSessionDbPath('/instance/home', 'podium-opencode-a'),
    })
  })

  it('resumes opencode by session id', () => {
    expect(
      opencodePlain(
        agentLaunchCommand('opencode', {
          ...ctx('opencode'),
          cwd: '/w',
          resume: { kind: 'opencode-session', value: 'ses_abc' },
        }),
      ),
    ).toEqual({ cmd: exe('opencode'), args: ['--session', 'ses_abc', '--auto'], cwd: '/w' })
  })

  it('passes model override to opencode', () => {
    expect(
      opencodePlain(
        agentLaunchCommand('opencode', { ...ctx('opencode'), cwd: '/w', model: 'openai/gpt-5.5' }),
      ),
    ).toEqual({
      cmd: exe('opencode'),
      args: ['-m', 'openai/gpt-5.5', '--auto'],
      cwd: '/w',
    })
  })

  it('spawns cursor fresh with its provider command', () => {
    expect(plain(agentLaunchCommand('cursor', { ...ctx('cursor'), cwd: '/w' }))).toEqual({
      cmd: exe('cursor'),
      args: [],
      cwd: '/w',
    })
  })

  it('resumes cursor by chat id', () => {
    expect(
      plain(
        agentLaunchCommand('cursor', {
          ...ctx('cursor'),
          cwd: '/w',
          resume: { kind: 'cursor-chat', value: 'chat-9' },
        }),
      ),
    ).toEqual({ cmd: exe('cursor'), args: ['--resume', 'chat-9'], cwd: '/w' })
  })

  it('passes model override to cursor', () => {
    expect(
      plain(agentLaunchCommand('cursor', { ...ctx('cursor'), cwd: '/w', model: 'composer-2.5' })),
    ).toEqual({
      cmd: exe('cursor'),
      args: ['--model', 'composer-2.5'],
      cwd: '/w',
    })
  })

  it('threads cwd through unchanged', () => {
    expect(agentLaunchCommand('claude-code', { ...ctx('claude-code'), cwd: '/a/b/c' }).cwd).toBe(
      '/a/b/c',
    )
  })

  describe('initialPrompt (argv injection — the robust, race-free first prompt)', () => {
    it('appends the prompt as a trailing positional arg for claude-code', () => {
      expect(
        claudePlain(
          agentLaunchCommand('claude-code', {
            ...ctx('claude-code'),
            cwd: '/w',
            initialPrompt: 'do the thing',
          }),
        ),
      ).toEqual({
        cmd: exe('claude-code'),
        args: [...CLAUDE_POSTURE_ARGS, '--', 'do the thing'],
        cwd: '/w',
      })
    })

    it('places the prompt LAST, after model/option args (claude-code)', () => {
      expect(
        claudePlain(
          agentLaunchCommand('claude-code', {
            ...ctx('claude-code'),
            cwd: '/w',
            model: 'opus',
            initialPrompt: 'fix login',
          }),
        ),
      ).toEqual({
        cmd: exe('claude-code'),
        args: ['--model', 'opus', ...CLAUDE_POSTURE_ARGS, '--', 'fix login'],
        cwd: '/w',
      })
    })

    it('appends the prompt as a positional arg for codex and grok', () => {
      expect(
        codexPlain(
          agentLaunchCommand('codex', { ...ctx('codex'), cwd: '/w', initialPrompt: 'do X' }),
        ),
      ).toEqual({
        cmd: exe('codex'),
        args: [...CODEX_POSTURE_ARGS, '--', 'do X'],
        cwd: '/w',
      })
      expect(
        plain(agentLaunchCommand('grok', { ...ctx('grok'), cwd: '/w', initialPrompt: 'do X' })),
      ).toEqual({
        cmd: exe('grok'),
        args: ['--', 'do X'],
        cwd: '/w',
      })
    })

    it('preserves multi-line prompts as a single argv token', () => {
      const prompt = 'line one\nline two'
      expect(
        agentLaunchCommand('claude-code', {
          ...ctx('claude-code'),
          cwd: '/w',
          initialPrompt: prompt,
        }).args,
      ).toEqual([...CLAUDE_POSTURE_ARGS, '--', prompt])
    })

    it('ignores a blank/whitespace-only prompt (no empty arg)', () => {
      expect(
        agentLaunchCommand('claude-code', {
          ...ctx('claude-code'),
          cwd: '/w',
          initialPrompt: '   ',
        }).args,
      ).toEqual(CLAUDE_POSTURE_ARGS)
      expect(
        agentLaunchCommand('claude-code', { ...ctx('claude-code'), cwd: '/w', initialPrompt: '' })
          .args,
      ).toEqual(CLAUDE_POSTURE_ARGS)
    })

    it('uses the OpenCode startup prompt rather than typing during TUI initialization', () => {
      expect(
        agentLaunchCommand('opencode', {
          ...ctx('opencode'),
          cwd: '/w',
          initialPrompt: '--help\nDo real work',
        }).args,
      ).toEqual(['--prompt=--help\nDo real work', '--auto'])
      expect(
        agentLaunchCommand('opencode', { ...ctx('opencode'), cwd: '/w', initialPrompt: '  ' }).args,
      ).toEqual(['--auto'])
    })

    it('does NOT append a prompt arg for non-argv agents (cursor/shell)', () => {
      expect(
        agentLaunchCommand('cursor', { ...ctx('cursor'), cwd: '/w', initialPrompt: 'x' }).args,
      ).toEqual([])
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
            const args = agentLaunchCommand(kind, {
              ...ctx(kind),
              cwd: '/w',
              initialPrompt: prompt,
            }).args
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
          ...ctx('claude-code'),
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
          ...CLAUDE_POSTURE_ARGS,
          '--',
          '- remove the dead code path',
        ])
      })

      it('emits NO `--` when there is no prompt (a bare launch stays bare)', () => {
        for (const kind of ['claude-code', 'codex', 'grok'] as const) {
          expect(agentLaunchCommand(kind, { ...ctx(kind), cwd: '/w' }).args).not.toContain('--')
          expect(
            agentLaunchCommand(kind, { ...ctx(kind), cwd: '/w', initialPrompt: '  ' }).args,
          ).not.toContain('--')
        }
      })

      it('passes the prompt UNTRIMMED — only the emptiness test trims', () => {
        const prompt = '  - keep my indentation  '
        expect(
          agentLaunchCommand('claude-code', {
            ...ctx('claude-code'),
            cwd: '/w',
            initialPrompt: prompt,
          }).args,
        ).toEqual([...CLAUDE_POSTURE_ARGS, '--', prompt])
      })
    })

    it('agentSupportsInitialPrompt: argv-capable agents only', () => {
      expect(agentSupportsInitialPrompt('claude-code')).toBe(true)
      expect(agentSupportsInitialPrompt('codex')).toBe(true)
      expect(agentSupportsInitialPrompt('grok')).toBe(true)
      expect(agentSupportsInitialPrompt('opencode')).toBe(true)
      expect(agentSupportsInitialPrompt('cursor')).toBe(false)
      expect(agentSupportsInitialPrompt('shell')).toBe(false)
    })
  })

  describe('machine-authored instruction channels', () => {
    const instructions = [{ source: 'podium:workflow', content: 'Follow the pinned workflow.' }]

    it('uses Claude system prompt without changing the user prompt token', () => {
      expect(
        claudePlain(
          agentLaunchCommand('claude-code', {
            ...ctx('claude-code'),
            cwd: '/w',
            instructions,
            initialPrompt: 'fix it',
          }),
        ),
      ).toEqual({
        cmd: exe('claude-code'),
        args: [
          '--append-system-prompt',
          'Follow the pinned workflow.',
          ...CLAUDE_POSTURE_ARGS,
          '--',
          'fix it',
        ],
        cwd: '/w',
      })
    })

    it('uses Codex developer instructions', () => {
      expect(
        agentLaunchCommand('codex', { ...ctx('codex'), cwd: '/w', instructions }).args,
      ).toEqual([
        '-c',
        'developer_instructions="Follow the pinned workflow."',
        ...CODEX_POSTURE_ARGS,
      ])
    })

    it('never places the stable Podium row id into Codex developer context', () => {
      const sessionId = 'f439e012-7cd1-4d39-a07e-5843caf35f0c'
      expect(
        agentLaunchCommand('codex', {
          ...ctx('codex'),
          cwd: '/w',
          podiumSessionId: asSessionId(sessionId),
        }).args,
      ).toEqual(CODEX_POSTURE_ARGS)
    })

    it('uses Grok rules', () => {
      expect(agentLaunchCommand('grok', { ...ctx('grok'), cwd: '/w', instructions }).args).toEqual([
        '--rules',
        'Follow the pinned workflow.',
      ])
    })

    it('uses OpenCode inline config plus a daemon-materialized instruction file', () => {
      const spec = agentLaunchCommand('opencode', {
        ...ctx('opencode'),
        cwd: '/w',
        runtimeDir: '/runtime/session',
        instructions,
        env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask"}}' },
      })
      expect(JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
        permission: { edit: 'ask', ...OPENCODE_POSTURE_PERMISSION },
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
        ...ctx('cursor'),
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
        agentLaunchCommand('claude-code', {
          ...ctx('claude-code'),
          cwd: '/w',
          model: 'opus',
          effort: 'high',
        }).args,
      ).toEqual(['--model', 'opus', '--effort', 'high', ...CLAUDE_POSTURE_ARGS])
    })

    it('grok takes --effort', () => {
      expect(
        agentLaunchCommand('grok', { ...ctx('grok'), cwd: '/w', effort: 'xhigh' }).args,
      ).toEqual(['--effort', 'xhigh'])
    })

    it('codex maps effort to a reasoning-effort config override', () => {
      expect(
        agentLaunchCommand('codex', { ...ctx('codex'), cwd: '/w', effort: 'high' }).args,
      ).toEqual(['-c', 'model_reasoning_effort=high', ...CODEX_POSTURE_ARGS])
    })

    it.each([
      'opencode-go/muse-spark-1.3-contributor',
      'opencode/muse-spark-1.3-contributor-free',
    ])('seeds the native TUI variant for %s without its run-only flag', (model) => {
      const spec = agentLaunchCommand('opencode', {
        ...ctx('opencode'),
        cwd: '/w',
        model,
        effort: 'low',
        runtimeDir: '/runtime/session',
        instructions: [{ source: 'test', content: 'Keep the instructions.' }],
      })
      expect(spec.args).toEqual(['-m', model, '--auto'])
      expect(spec.env?.XDG_STATE_HOME).toBe('/runtime/session/opencode-state')
      expect(spec.files?.[0]).toEqual({
        path: '/runtime/session/opencode-state/opencode/model.json',
        contents: JSON.stringify({ variant: { [model]: 'low' } }),
      })
      expect(spec.files?.[1]?.contents).toBe('Keep the instructions.')
    })

    it('does not silently discard terminal effort without a model or runtime directory', () => {
      expect(() =>
        agentLaunchCommand('opencode', { ...ctx('opencode'), cwd: '/w', effort: 'high' }),
      ).toThrow('requires an explicit model')
      expect(() =>
        agentLaunchCommand('opencode', {
          ...ctx('opencode'),
          cwd: '/w',
          model: 'opencode/test',
          effort: 'high',
        }),
      ).toThrow('requires a session runtime directory')
    })

    it('leaves native defaults alone when OpenCode effort is auto', () => {
      expect(
        opencodePlain(
          agentLaunchCommand('opencode', { ...ctx('opencode'), cwd: '/w', effort: 'auto' }),
        ),
      ).toEqual({
        cmd: exe('opencode'),
        args: ['--auto'],
        cwd: '/w',
      })
    })

    it('cursor has no effort flag — effort is dropped', () => {
      expect(
        agentLaunchCommand('cursor', { ...ctx('cursor'), cwd: '/w', effort: 'high' }).args,
      ).toEqual([])
    })

    it("'auto' (the sentinel) emits no model or effort flag", () => {
      expect(
        agentLaunchCommand('claude-code', {
          ...ctx('claude-code'),
          cwd: '/w',
          model: 'auto',
          effort: 'auto',
        }).args,
      ).toEqual(CLAUDE_POSTURE_ARGS)
      expect(
        agentLaunchCommand('codex', { ...ctx('codex'), cwd: '/w', model: 'auto', effort: 'auto' })
          .args,
      ).toEqual(CODEX_POSTURE_ARGS)
    })
  })

  it('spawns an interactive shell in the worktree cwd', () => {
    expect(plain(agentLaunchCommand('shell', { cwd: '/w', env: { SHELL: '/bin/zsh' } }))).toEqual({
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

describe('windowsDefaultShell', () => {
  const env = { ProgramFiles: 'C:\\PF', SystemRoot: 'C:\\Win', COMSPEC: 'C:\\Win\\cmd.exe' }
  it('prefers PowerShell 7, then Windows PowerShell, then COMSPEC', () => {
    const pwsh = join('C:\\PF', 'PowerShell', '7', 'pwsh.exe')
    const winps = join('C:\\Win', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    expect(windowsDefaultShell(env, (p) => p === pwsh || p === winps)).toBe(pwsh)
    expect(windowsDefaultShell(env, (p) => p === winps)).toBe(winps)
    expect(windowsDefaultShell(env, () => false)).toBe('C:\\Win\\cmd.exe')
  })
})
