/**
 * Grok's launch terms (POD-6858 Task 7; docs/design/harness-session-posture.md
 * §4.8): the exact args, env, files, home edits, requested mode and unmet
 * entries for every launch mode and mode level. Grok has no inline config
 * value, so the rules carry folder and server names verbatim.
 */
import type { SessionPosture } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { testHarnessContext } from '../../driver/testing/harness-context.js'
import { applyTerms, launchTerms } from '../../posture.js'
import {
  LAUNCH_MODES,
  type LaunchMode,
  type PostureLaunch,
  type PostureRequest,
} from '../../posture-types.js'
import { grokManifest } from './index.js'
import { grokPosture } from './posture.js'

const WORKDIR = '/work/repo/.worktrees/issue-1'
const RUNTIME_DIR = '/run/podium/sessions/s1'

function request(mode: LaunchMode, posture: SessionPosture): PostureRequest {
  return {
    mode,
    posture,
    grants: {
      podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
      uploadsDir: '/var/lib/podium/uploads/s1',
      mcpServers: ['podium', 'issue tracker'],
    },
    workdir: WORKDIR,
    repoRoot: '/work/repo',
    runtimeDir: RUNTIME_DIR,
    context: testHarnessContext({ kind: 'grok', version: '1.0.70' }),
  }
}

const SUPERVISED: SessionPosture = { mode: 'supervised' }
const AUTONOMOUS: SessionPosture = { mode: 'autonomous' }

/** What each launch builder emits, in the shape the adapter and family build it. */
const BUILDER: Record<LaunchMode, PostureLaunch> = {
  // `launch()`: a new session with a `--` prompt boundary.
  terminal: {
    args: ['--session-id', 'uuid-1', '--model', 'grok-4.6', '--', '-a prompt'],
    env: { HARNESS_TERMINAL_ID: 's1', CLAUDE_HARNESS_ID: 's1' },
    files: [],
  },
  // The ACP engine: `grok agent stdio`.
  engine: { args: ['agent', 'stdio'], env: {}, files: [] },
  // `headless.buildExec`: the prompt is `--single`'s value, last.
  turn: {
    args: ['--resume', 'uuid-1', '--rules', 'be brief', '--single', '-a prompt'],
    env: {},
    files: [],
  },
  // `clientTerminal.launch`: the stock TUI reopening the engine's session.
  client: { args: ['--resume', 'uuid-1'], env: {}, files: [] },
}

/** The rules a terminal, client or turn launch carries. */
const ALLOW = [
  '--allow',
  'Bash(podium *)',
  '--allow',
  'MCPTool(podium__*)',
  '--allow',
  'MCPTool(issue tracker__*)',
]

/** The engine's allow rule: one entry in the user config's `[permission] allow`. */
const ENGINE_ALLOW_EDIT = {
  kind: 'toml-array-entry',
  file: '/home/podium-test/.grok/config.toml',
  path: ['permission', 'allow'],
  value: 'Bash(podium *)',
  serves: 'podium-cli',
  createIfMissing: true,
} as const

describe('grokPosture', () => {
  describe.each(LAUNCH_MODES)('%s managed updater control', (mode) => {
    it('disables the updater for managed releases and preserves the other launch terms', () => {
      const base = request(mode, SUPERVISED)
      const launch = {
        ...BUILDER[mode],
        env: { ...BUILDER[mode].env, KEEP: 'value', GROK_DISABLE_AUTOUPDATER: '0' },
      }
      const external = grokPosture(launch, base)
      const managed = grokPosture(launch, {
        ...base,
        context: testHarnessContext({ kind: 'grok', version: '1.0.89', provenance: 'managed' }),
      })
      expect(managed).toEqual({
        ...external,
        launch: {
          ...external.launch,
          env: { ...launch.env, GROK_DISABLE_AUTOUPDATER: '1' },
        },
      })
      expect(launch.env.GROK_DISABLE_AUTOUPDATER).toBe('0')
    })

    it("leaves an external installation's update policy unchanged", () => {
      const out = grokPosture(BUILDER[mode], request(mode, SUPERVISED))
      expect(out.launch.env).toEqual(BUILDER[mode].env)
      expect(out.launch.env).not.toHaveProperty('GROK_DISABLE_AUTOUPDATER')
    })
  })

  it('terminal / supervised: --permission-mode default and the allow rules, before the prompt boundary', () => {
    const out = grokPosture(BUILDER.terminal, request('terminal', SUPERVISED))
    expect(out.launch).toEqual({
      args: [
        '--session-id',
        'uuid-1',
        '--model',
        'grok-4.6',
        '--trust',
        '--permission-mode',
        'default',
        ...ALLOW,
        '--',
        '-a prompt',
      ],
      env: BUILDER.terminal.env,
      files: [],
    })
    expect(out.homeEdits).toEqual([])
    expect(out.requestedMode).toBe('default')
    expect(out.unmet).toEqual([])
  })

  it('terminal / autonomous: --permission-mode auto', () => {
    const out = grokPosture(BUILDER.terminal, request('terminal', AUTONOMOUS))
    expect(out.launch.args).toEqual([
      '--session-id',
      'uuid-1',
      '--model',
      'grok-4.6',
      '--trust',
      '--permission-mode',
      'auto',
      ...ALLOW,
      '--',
      '-a prompt',
    ])
    expect(out.requestedMode).toBe('auto')
    expect(out.unmet).toEqual([])
  })

  for (const [posture, word] of [
    [SUPERVISED, 'default'],
    [AUTONOMOUS, 'auto'],
  ] as const) {
    it(`turn / ${posture.mode}: options go before --single, whose value is the prompt`, () => {
      const out = grokPosture(BUILDER.turn, request('turn', posture))
      expect(out.launch).toEqual({
        args: [
          '--resume',
          'uuid-1',
          '--rules',
          'be brief',
          '--trust',
          '--permission-mode',
          word,
          ...ALLOW,
          '--single',
          '-a prompt',
        ],
        env: {},
        files: [],
      })
      expect(out.homeEdits).toEqual([])
      expect(out.requestedMode).toBe(word)
      expect(out.unmet).toEqual([])
    })

    it(`client / ${posture.mode}: the attached TUI runs its own tools, so it gets the terminal's terms`, () => {
      const out = grokPosture(BUILDER.client, request('client', posture))
      expect(out.launch.args).toEqual([
        '--resume',
        'uuid-1',
        '--trust',
        '--permission-mode',
        word,
        ...ALLOW,
      ])
      expect(out.requestedMode).toBe(word)
      expect(out.unmet).toEqual([])
    })

    it(`engine / ${posture.mode}: no flag; the family sets ${word}; the CLI rule goes into the user config`, () => {
      const out = grokPosture(BUILDER.engine, request('engine', posture))
      expect(out.launch).toEqual(BUILDER.engine)
      expect(out.homeEdits).toEqual([ENGINE_ALLOW_EDIT])
      expect(out.requestedMode).toBe(word)
      expect(out.unmet).toEqual([])
    })
  }

  it("passes a native pick through when it is one of Grok's own modes", () => {
    const out = grokPosture(BUILDER.terminal, request('terminal', { mode: { native: 'plan' } }))
    expect(out.launch.args).toContain('plan')
    expect(out.launch.args[out.launch.args.indexOf('plan') - 1]).toBe('--permission-mode')
    expect(out.requestedMode).toBe('plan')
    expect(out.unmet).toEqual([])
  })

  it('reports a native pick Grok has no mode for as unmet autonomy, and sends no mode flag', () => {
    const out = grokPosture(BUILDER.turn, request('turn', { mode: { native: 'on-request' } }))
    expect(out.launch.args).not.toContain('--permission-mode')
    expect(out.launch.args).toContain('--allow')
    expect(out.requestedMode).toBeNull()
    expect(out.unmet).toEqual([
      {
        requirement: 'autonomy',
        reason:
          'Grok has no permission mode named "on-request", so it starts in the mode its own settings choose',
      },
    ])
  })

  it('engine: the rule follows a GROK_HOME the context selects', () => {
    const base = request('engine', AUTONOMOUS)
    const out = grokPosture(BUILDER.engine, {
      ...base,
      context: testHarnessContext({
        kind: 'grok',
        version: '1.0.70',
        env: { GROK_HOME: '/var/lib/podium/agent-home/.grok' },
      }),
    })
    expect(out.homeEdits).toEqual([
      { ...ENGINE_ALLOW_EDIT, file: '/var/lib/podium/agent-home/.grok/config.toml' },
    ])
    expect(out.unmet).toEqual([])
  })

  it('engine: names the CLI by its granted name in the rule', () => {
    const out = grokPosture(BUILDER.engine, {
      ...request('engine', SUPERVISED),
      grants: { podiumCli: { name: 'podium-dev', path: '/x' }, uploadsDir: '/u', mcpServers: [] },
    })
    expect(out.homeEdits).toEqual([{ ...ENGINE_ALLOW_EDIT, value: 'Bash(podium-dev *)' }])
  })

  it('terminal, turn and client carry the rule by flag and edit no home', () => {
    for (const mode of ['terminal', 'turn', 'client'] as const) {
      expect(grokPosture(BUILDER[mode], request(mode, SUPERVISED)).homeEdits).toEqual([])
    }
  })

  it('names the CLI by its granted name', () => {
    const out = grokPosture(BUILDER.client, {
      ...request('client', AUTONOMOUS),
      grants: { podiumCli: { name: 'podium-dev', path: '/x' }, uploadsDir: '/u', mcpServers: [] },
    })
    expect(out.launch.args).toEqual([
      '--resume',
      'uuid-1',
      '--trust',
      '--permission-mode',
      'auto',
      '--allow',
      'Bash(podium-dev *)',
    ])
  })

  describe('folder trust (POD-6999)', () => {
    function at(mode: LaunchMode, version: string): PostureRequest {
      return {
        ...request(mode, SUPERVISED),
        context: testHarnessContext({ kind: 'grok', version }),
      }
    }

    it('passes --trust from 1.0.5, the oldest Grok measured to take it', () => {
      for (const version of ['1.0.5', '1.0.52', '1.0.70', '2.0.0']) {
        for (const mode of ['terminal', 'turn', 'client'] as const) {
          const out = grokPosture(BUILDER[mode], at(mode, version))
          expect(out.launch.args).toContain('--trust')
          expect(out.unmet).toEqual([])
        }
      }
    })

    it('passes nothing below 1.0.5 or with an unknown version, and reports trust unmet', () => {
      for (const [version, named] of [
        ['1.0.4', 'version "1.0.4"'],
        ['0.2.23', 'version "0.2.23"'],
        ['', 'of unknown version'],
        ['grok dev build', 'version "grok dev build"'],
      ] as const) {
        const out = grokPosture(BUILDER.terminal, at('terminal', version))
        expect(out.launch.args).not.toContain('--trust')
        expect(out.unmet).toEqual([
          {
            requirement: 'workspace-trust',
            reason: `Grok ${named} is not known to take --trust (from 1.0.5), so it may ask whether to trust the folder`,
          },
        ])
      }
    })

    it('engine: grok agent stdio refuses --trust, so the engine gets none', () => {
      const out = grokPosture(BUILDER.engine, at('engine', '1.0.70'))
      expect(out.launch.args).not.toContain('--trust')
      expect(out.unmet).toEqual([])
    })
  })

  it('passes the contract checks in every launch mode', () => {
    for (const mode of LAUNCH_MODES) {
      for (const posture of [SUPERVISED, AUTONOMOUS]) {
        expect(() =>
          applyTerms(BUILDER[mode], launchTerms(grokManifest, request(mode, posture))),
        ).not.toThrow()
      }
    }
  })
})
