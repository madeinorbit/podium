/**
 * OpenCode's launch terms (POD-6858 Task 6; docs/design/harness-session-posture.md
 * §4.8): the exact args, env, files, home edits, requested mode and unmet
 * entries for every launch mode and mode level; the merge into an inline config
 * that already holds instructions and permission rules; and the inline JSON
 * value for folder paths that break naive quoting (Review Focus 4).
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
import { opencodeManifest } from './index.js'
import { opencodePosture } from './posture.js'

const HOME = '/home/podium-test'
const WORKDIR = '/work/repo/.worktrees/issue-1'
const RUNTIME_DIR = '/run/podium/sessions/s1'
const UPLOADS = '/var/lib/podium/uploads/s1'
const INSTRUCTIONS = `${RUNTIME_DIR}/podium-instructions.md`

function request(
  mode: LaunchMode,
  posture: SessionPosture,
  over: Partial<PostureRequest> & { contextEnv?: Record<string, string> } = {},
): PostureRequest {
  const { contextEnv, ...rest } = over
  return {
    mode,
    posture,
    grants: {
      podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
      uploadsDir: UPLOADS,
      mcpServers: ['podium'],
    },
    workdir: WORKDIR,
    repoRoot: '/work/repo',
    runtimeDir: RUNTIME_DIR,
    context: testHarnessContext({
      kind: 'opencode',
      home: HOME,
      version: '1.18.35',
      ...(contextEnv ? { env: contextEnv } : {}),
    }),
    ...rest,
  }
}

const SUPERVISED: SessionPosture = { mode: 'supervised' }
const AUTONOMOUS: SessionPosture = { mode: 'autonomous' }

/** What each launch builder emits, in the shape the adapter and family build it. */
const BUILDER: Record<LaunchMode, PostureLaunch> = {
  // `launch()`: a resume with a model, a startup prompt that looks like an
  // option, the session's own store and the instruction file in the inline config.
  terminal: {
    args: ['--session', 'ses_1', '-m', 'openai/gpt-5.5', '--prompt=--help'],
    env: {
      OPENCODE_DB: '/home/podium-test/.local/share/opencode/s1.db',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: [INSTRUCTIONS] }),
    },
    files: [{ path: INSTRUCTIONS, contents: 'Follow the pinned workflow.' }],
  },
  // The engine host: `serve` with its port and loopback host.
  engine: {
    args: ['serve', '--port', '4100', '--hostname', '127.0.0.1'],
    env: {},
    files: [],
  },
  // `headless.buildExec` on a second turn: the prompt is the last positional.
  turn: {
    args: ['run', '--format', 'json', '-s', 'ses_1', '-m', 'openai/gpt-5.5', '-- a prompt'],
    env: {},
    files: [],
  },
  // `clientTerminal.launch`: the stock TUI joined to the engine.
  client: {
    args: ['attach', 'http://127.0.0.1:4100', '--session', 'ses_1'],
    env: { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: 'pw' },
    files: [],
  },
}

/** The rules every agent launch carries: the Podium CLI and the uploads folder. */
const AUTONOMOUS_PERMISSION = {
  bash: { 'podium *': 'allow' },
  external_directory: { [`${UPLOADS}/*`]: 'allow' },
}
/** Supervised adds an ask for every other command and for every edit. */
const SUPERVISED_PERMISSION = {
  bash: { '*': 'ask', 'podium *': 'allow' },
  external_directory: { [`${UPLOADS}/*`]: 'allow' },
  edit: 'ask',
}

interface Expected {
  args: string[]
  /** The parsed inline config, or `undefined` when the launch carries none. */
  config: unknown
  requestedMode: string | null
  unmet: { requirement: string; reason: string }[]
}

const TURN_NOBODY_TO_ASK = {
  requirement: 'autonomy',
  reason: 'a one-shot OpenCode run has nobody to answer its asks',
}

const EXPECTED: Record<LaunchMode, Record<'supervised' | 'autonomous', Expected>> = {
  terminal: {
    supervised: {
      args: BUILDER.terminal.args as string[],
      config: { instructions: [INSTRUCTIONS], permission: SUPERVISED_PERMISSION },
      requestedMode: 'ask',
      unmet: [],
    },
    autonomous: {
      args: [...BUILDER.terminal.args, '--auto'],
      config: { instructions: [INSTRUCTIONS], permission: AUTONOMOUS_PERMISSION },
      requestedMode: 'auto',
      unmet: [],
    },
  },
  engine: {
    // `serve` takes no `--auto`: its asks reach chat, as they do today.
    supervised: {
      args: BUILDER.engine.args as string[],
      config: { permission: SUPERVISED_PERMISSION },
      requestedMode: 'ask',
      unmet: [],
    },
    autonomous: {
      args: BUILDER.engine.args as string[],
      config: { permission: AUTONOMOUS_PERMISSION },
      requestedMode: null,
      unmet: [],
    },
  },
  turn: {
    supervised: {
      args: BUILDER.turn.args as string[],
      config: { permission: SUPERVISED_PERMISSION },
      requestedMode: 'ask',
      unmet: [TURN_NOBODY_TO_ASK],
    },
    // `--auto` right after `run`, ahead of the prompt positional.
    autonomous: {
      args: [
        'run',
        '--auto',
        '--format',
        'json',
        '-s',
        'ses_1',
        '-m',
        'openai/gpt-5.5',
        '-- a prompt',
      ],
      config: { permission: AUTONOMOUS_PERMISSION },
      requestedMode: 'auto',
      unmet: [],
    },
  },
  // The engine evaluates every permission; the attached TUI adds nothing.
  client: {
    supervised: {
      args: BUILDER.client.args as string[],
      config: undefined,
      requestedMode: null,
      unmet: [],
    },
    autonomous: {
      args: BUILDER.client.args as string[],
      config: undefined,
      requestedMode: null,
      unmet: [],
    },
  },
}

function configOf(env: Readonly<Record<string, string>>): unknown {
  const raw = env.OPENCODE_CONFIG_CONTENT
  return raw === undefined ? undefined : JSON.parse(raw)
}

describe('opencodePosture', () => {
  for (const mode of LAUNCH_MODES) {
    for (const level of ['supervised', 'autonomous'] as const) {
      it(`${mode}, ${level}`, () => {
        const posture = level === 'supervised' ? SUPERVISED : AUTONOMOUS
        const out = applyTerms(BUILDER[mode], launchTerms(opencodeManifest, request(mode, posture)))
        const want = EXPECTED[mode][level]
        expect(out.launch.args).toEqual(want.args)
        expect(configOf(out.launch.env)).toEqual(want.config)
        const { OPENCODE_CONFIG_CONTENT: _config, ...otherEnv } = out.launch.env
        const { OPENCODE_CONFIG_CONTENT: _builderConfig, ...builderEnv } = BUILDER[mode].env
        expect(otherEnv).toEqual(builderEnv)
        expect(out.launch.files).toEqual(BUILDER[mode].files)
        expect(out.applied).toEqual({
          homeEdits: [],
          requestedMode: want.requestedMode,
          unmet: want.unmet,
        })
      })
    }
  }

  it('is the section the manifest declares', () => {
    expect(opencodeManifest.posture).toBe(opencodePosture)
  })

  describe('a native mode pick', () => {
    it('passes OpenCode\'s own "auto" through as the autonomous terms', () => {
      const out = opencodePosture(
        BUILDER.terminal,
        request('terminal', { mode: { native: 'auto' } }),
      )
      expect(out.launch.args).toEqual(EXPECTED.terminal.autonomous.args)
      expect(configOf(out.launch.env)).toEqual(EXPECTED.terminal.autonomous.config)
      expect(out.requestedMode).toBe('auto')
      expect(out.unmet).toEqual([])
    })

    it('passes OpenCode\'s own "ask" through as the supervised terms', () => {
      const out = opencodePosture(
        BUILDER.terminal,
        request('terminal', { mode: { native: 'ask' } }),
      )
      expect(out.launch.args).toEqual(EXPECTED.terminal.supervised.args)
      expect(configOf(out.launch.env)).toEqual(EXPECTED.terminal.supervised.config)
      expect(out.requestedMode).toBe('ask')
      expect(out.unmet).toEqual([])
    })

    it('reports a word OpenCode has no mode for, and still pre-approves the CLI', () => {
      const out = opencodePosture(
        BUILDER.terminal,
        request('terminal', { mode: { native: 'plan' } }),
      )
      expect(out.launch.args).toEqual(BUILDER.terminal.args)
      expect(configOf(out.launch.env)).toEqual({
        instructions: [INSTRUCTIONS],
        permission: AUTONOMOUS_PERMISSION,
      })
      expect(out.requestedMode).toBeNull()
      expect(out.unmet).toEqual([
        {
          requirement: 'autonomy',
          reason:
            'OpenCode has no permission mode named "plan", so it starts on its own permission settings',
        },
      ])
    })
  })

  describe('the inline config it merges into', () => {
    const userConfig = {
      model: 'openai/gpt-5.5',
      instructions: ['/home/podium-test/AGENTS.extra.md', INSTRUCTIONS],
      permission: {
        webfetch: 'ask',
        bash: { 'git *': 'allow', 'podium *': 'deny', 'rm *': 'deny' },
        edit: { 'docs/*': 'allow' },
        external_directory: 'deny',
      },
    }
    const launchWith = (config: unknown): PostureLaunch => ({
      args: [],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      files: [],
    })

    it('keeps an existing instructions list and permission block (autonomous)', () => {
      const out = opencodePosture(launchWith(userConfig), request('terminal', AUTONOMOUS))
      const config = configOf(out.launch.env) as typeof userConfig
      expect(config).toEqual({
        model: 'openai/gpt-5.5',
        instructions: ['/home/podium-test/AGENTS.extra.md', INSTRUCTIONS],
        permission: {
          webfetch: 'ask',
          bash: { 'git *': 'allow', 'rm *': 'deny', 'podium *': 'allow' },
          edit: { 'docs/*': 'allow' },
          external_directory: { '*': 'deny', [`${UPLOADS}/*`]: 'allow' },
        },
      })
      // The CLI's rule is the last bash rule, so it wins over every glob
      // above it; the uploads rule likewise follows the person's own.
      expect(Object.keys(config.permission.bash).at(-1)).toBe('podium *')
      expect(Object.keys(config.permission.external_directory).at(-1)).toBe(`${UPLOADS}/*`)
    })

    it("puts the ask first under supervised, so the person's narrower rules still win", () => {
      const out = opencodePosture(launchWith(userConfig), request('terminal', SUPERVISED))
      const config = configOf(out.launch.env) as { permission: Record<string, unknown> }
      expect(config.permission).toEqual({
        webfetch: 'ask',
        bash: { '*': 'ask', 'git *': 'allow', 'rm *': 'deny', 'podium *': 'allow' },
        edit: { '*': 'ask', 'docs/*': 'allow' },
        external_directory: { '*': 'deny', [`${UPLOADS}/*`]: 'allow' },
      })
      expect(Object.keys(config.permission.bash as object)).toEqual([
        '*',
        'git *',
        'rm *',
        'podium *',
      ])
    })

    it('never loosens a deny to an ask under supervised', () => {
      const out = opencodePosture(
        launchWith({ permission: { bash: 'deny', edit: { '*': 'deny' } } }),
        request('engine', SUPERVISED),
      )
      expect(configOf(out.launch.env)).toEqual({
        permission: {
          bash: { '*': 'deny', 'podium *': 'allow' },
          edit: { '*': 'deny' },
          external_directory: { [`${UPLOADS}/*`]: 'allow' },
        },
      })
    })

    it('spreads a one-word permission over every tool before its own rules', () => {
      const out = opencodePosture(launchWith({ permission: 'ask' }), request('engine', AUTONOMOUS))
      const config = configOf(out.launch.env) as { permission: Record<string, unknown> }
      expect(config.permission).toEqual({ '*': 'ask', ...AUTONOMOUS_PERMISSION })
      expect(Object.keys(config.permission)[0]).toBe('*')
    })

    it('reads the launch env first, then the context env, then nothing', () => {
      const contextEnv = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['/from/context.md'] }),
      }
      const fromLaunch = opencodePosture(
        launchWith({ instructions: ['/from/launch.md'] }),
        request('engine', AUTONOMOUS, { contextEnv }),
      )
      expect(configOf(fromLaunch.launch.env)).toEqual({
        instructions: ['/from/launch.md'],
        permission: AUTONOMOUS_PERMISSION,
      })

      const fromContext = opencodePosture(
        BUILDER.engine,
        request('engine', AUTONOMOUS, { contextEnv }),
      )
      expect(configOf(fromContext.launch.env)).toEqual({
        instructions: ['/from/context.md'],
        permission: AUTONOMOUS_PERMISSION,
      })

      const fromNothing = opencodePosture(BUILDER.engine, request('engine', AUTONOMOUS))
      expect(configOf(fromNothing.launch.env)).toEqual({ permission: AUTONOMOUS_PERMISSION })
    })

    it('refuses a malformed existing config rather than discard it', () => {
      const broken: PostureLaunch = {
        args: [],
        env: { OPENCODE_CONFIG_CONTENT: '{"instructions": [' },
        files: [],
      }
      expect(() => opencodePosture(broken, request('terminal', AUTONOMOUS))).toThrow(
        /malformed OPENCODE_CONFIG_CONTENT/,
      )
      expect(() =>
        opencodePosture(
          BUILDER.engine,
          request('engine', AUTONOMOUS, { contextEnv: { OPENCODE_CONFIG_CONTENT: '[1]' } }),
        ),
      ).toThrow(/malformed OPENCODE_CONFIG_CONTENT/)
      expect(() =>
        opencodePosture(launchWith({ permission: 7 }), request('engine', AUTONOMOUS)),
      ).toThrow(/malformed OPENCODE_CONFIG_CONTENT/)
      expect(() =>
        opencodePosture(launchWith({ permission: { bash: ['x'] } }), request('engine', AUTONOMOUS)),
      ).toThrow(/malformed OPENCODE_CONFIG_CONTENT/)
    })
  })

  describe('a folder path that breaks naive quoting (Review Focus 4)', () => {
    it.each([
      ['a quote, a space and a non-ASCII letter', '/tmp/a "b"/c é'],
      ['a Windows path with backslashes', 'C:\\Users\\a b\\uploads'],
    ])('keeps %s exact in the inline JSON', (_label, uploadsDir) => {
      const base = request('terminal', AUTONOMOUS)
      const out = opencodePosture(BUILDER.engine, {
        ...base,
        grants: { ...base.grants, uploadsDir },
      })
      const raw = out.launch.env.OPENCODE_CONFIG_CONTENT ?? ''
      const config = JSON.parse(raw) as {
        permission: { external_directory: Record<string, string> }
      }
      expect(config.permission.external_directory).toEqual({ [`${uploadsDir}/*`]: 'allow' })
    })
  })
})
