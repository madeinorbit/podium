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

const ENGINE_CLI_REASON =
  '`grok agent stdio` takes no allow rule per launch; in default mode it asks before running podium, and under auto mode its classifier decides'

describe('grokPosture', () => {
  it('terminal / supervised: --permission-mode default and the allow rules, before the prompt boundary', () => {
    const out = grokPosture(BUILDER.terminal, request('terminal', SUPERVISED))
    expect(out.launch).toEqual({
      args: [
        '--session-id',
        'uuid-1',
        '--model',
        'grok-4.6',
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
      expect(out.launch.args).toEqual(['--resume', 'uuid-1', '--permission-mode', word, ...ALLOW])
      expect(out.requestedMode).toBe(word)
      expect(out.unmet).toEqual([])
    })

    it(`engine / ${posture.mode}: no flag; the family sets ${word}; the CLI rule is unmet`, () => {
      const out = grokPosture(BUILDER.engine, request('engine', posture))
      expect(out.launch).toEqual(BUILDER.engine)
      expect(out.homeEdits).toEqual([])
      expect(out.requestedMode).toBe(word)
      expect(out.unmet).toEqual([{ requirement: 'podium-cli', reason: ENGINE_CLI_REASON }])
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

  it('names the CLI by its granted name', () => {
    const out = grokPosture(BUILDER.client, {
      ...request('client', AUTONOMOUS),
      grants: { podiumCli: { name: 'podium-dev', path: '/x' }, uploadsDir: '/u', mcpServers: [] },
    })
    expect(out.launch.args).toEqual([
      '--resume',
      'uuid-1',
      '--permission-mode',
      'auto',
      '--allow',
      'Bash(podium-dev *)',
    ])
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
