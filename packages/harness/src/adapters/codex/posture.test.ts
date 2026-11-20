/**
 * Codex's launch terms (POD-6858 Task 5; docs/design/harness-session-posture.md
 * §4.8): the exact args, env, files, home edits, requested mode and unmet
 * entries for every launch mode and mode level, and the inline TOML value for
 * folder paths that break naive quoting (Review Focus 4).
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
import { codexManifest } from './index.js'
import { codexLaunchHookTrustSupported, codexPosture } from './posture.js'

/** Quiet start, unmet: a Codex not measured to take per-launch hook trust. */
function hookReviewUnmet(named: string) {
  return {
    requirement: 'quiet-start',
    reason: `Codex ${named} is not measured to take trust for Podium's hooks per launch (from 0.147.0), so it may ask to review them at startup`,
  }
}

const HOME = '/home/podium-test'
const CODEX_HOME = `${HOME}/.codex`
const WORKDIR = '/work/repo/.worktrees/issue-1'
const REPO_ROOT = '/work/repo'
const RUNTIME_DIR = '/run/podium/sessions/s1'

function request(
  mode: LaunchMode,
  posture: SessionPosture,
  over: Partial<PostureRequest> & { version?: string } = {},
): PostureRequest {
  const { version, ...rest } = over
  return {
    mode,
    posture,
    grants: {
      podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
      uploadsDir: '/var/lib/podium/uploads/s1',
      mcpServers: ['podium', 'issue tracker'],
    },
    workdir: WORKDIR,
    repoRoot: REPO_ROOT,
    runtimeDir: RUNTIME_DIR,
    context: testHarnessContext({ kind: 'codex', home: HOME, version: version ?? '0.167.2' }),
    ...rest,
  }
}

const SUPERVISED: SessionPosture = { mode: 'supervised' }
const AUTONOMOUS: SessionPosture = { mode: 'autonomous' }

/** What each launch builder emits, in the shape the adapter and family build it. */
const BUILDER: Record<LaunchMode, PostureLaunch> = {
  // `launch()`: a resume with a `--` prompt boundary.
  terminal: {
    args: ['resume', '-C', WORKDIR, 'thread-1', '--model', 'gpt-6', '--', '-a prompt'],
    env: { PODIUM_SESSION: 's1' },
    files: [],
  },
  // `codexAppServerConfigArgs`: one Podium MCP server mounted, one granted
  // server ("issue tracker") not mounted by this launch.
  engine: {
    args: [
      'app-server',
      '-c',
      'mcp_servers."podium".url="http://127.0.0.1:4100/mcp"',
      '-c',
      'mcp_servers."podium".bearer_token_env_var="PODIUM_MCP_TOKEN_PODIUM"',
    ],
    env: { PODIUM_MCP_TOKEN_PODIUM: 't' },
    files: [],
  },
  // `headless.buildExec` on a second turn: the prompt is the last positional,
  // and `exec resume` takes no `--approve-for-me`, so options go before `resume`.
  turn: {
    args: [
      'exec',
      'resume',
      'thread-1',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'mcp_servers."podium".url="http://127.0.0.1:4100/mcp"',
      'hello',
    ],
    env: {},
    files: [],
  },
  // `clientTerminal.launch`: the stock TUI joined to the engine.
  client: {
    args: ['resume', '-C', WORKDIR, 'thread-1', '--remote', 'unix:///run/podium/cx.sock'],
    env: {},
    files: [],
  },
}

/** A worktree session trusts both folders a launch can open: the main checkout
 *  (Codex resolves a worktree's trust to it) and the worktree itself (a
 *  `resume -C <worktree> --remote` client is checked on its `-C` folder). */
const TRUST = [
  '-c',
  'projects={"/work/repo"={trust_level="trusted"},"/work/repo/.worktrees/issue-1"={trust_level="trusted"}}',
]
/** Every `projects=` override among the args: there must be exactly one, since
 *  a second `-c projects=` would replace the first rather than add to it. */
function projectsArgs(args: readonly string[]): string[] {
  return args.filter((arg) => arg.startsWith('projects='))
}

const QUIET = ['-c', 'check_for_update_on_startup=false']
const NETWORK = ['-c', 'sandbox_workspace_write.network_access=true']
const WORKSPACE_WRITE = ['-c', 'sandbox_mode="workspace-write"']
const MCP_APPROVE = ['-c', 'mcp_servers."podium".default_tools_approval_mode="approve"']

const RULE_EDIT = {
  kind: 'owned-file',
  file: `${CODEX_HOME}/rules/podium.rules`,
  contents:
    '# Written by Podium. Lets agents run the Podium CLI without asking.\n' +
    'prefix_rule(pattern = ["podium"], decision = "allow", justification = "Podium CLI: required for an agent to work inside Podium")\n',
  serves: 'podium-cli',
} as const

interface Expected {
  args: string[]
  requestedMode: string | null
  unmet: { requirement: string; reason: string }[]
}

const EXPECTED: Record<LaunchMode, Record<'supervised' | 'autonomous', Expected>> = {
  terminal: {
    supervised: {
      args: [
        'resume',
        '-C',
        WORKDIR,
        'thread-1',
        '--model',
        'gpt-6',
        ...TRUST,
        ...QUIET,
        ...NETWORK,
        '-a',
        'on-request',
        '--',
        '-a prompt',
      ],
      requestedMode: 'on-request',
      unmet: [],
    },
    autonomous: {
      args: [
        'resume',
        '-C',
        WORKDIR,
        'thread-1',
        '--model',
        'gpt-6',
        ...TRUST,
        ...QUIET,
        ...NETWORK,
        '--approve-for-me',
        '--',
        '-a prompt',
      ],
      requestedMode: 'auto-review',
      unmet: [],
    },
  },
  engine: {
    supervised: {
      args: [...BUILDER.engine.args, ...TRUST, ...WORKSPACE_WRITE, ...NETWORK, ...MCP_APPROVE],
      requestedMode: 'on-request',
      unmet: [],
    },
    autonomous: {
      args: [
        ...BUILDER.engine.args,
        ...TRUST,
        ...WORKSPACE_WRITE,
        ...NETWORK,
        ...MCP_APPROVE,
        '-c',
        'approvals_reviewer="auto_review"',
      ],
      requestedMode: 'auto-review',
      unmet: [],
    },
  },
  turn: {
    supervised: {
      args: ['exec', ...TRUST, ...NETWORK, ...MCP_APPROVE, ...BUILDER.turn.args.slice(1)],
      requestedMode: null,
      unmet: [{ requirement: 'autonomy', reason: 'a one-shot Codex run has nobody to ask' }],
    },
    autonomous: {
      args: [
        'exec',
        ...TRUST,
        ...NETWORK,
        ...MCP_APPROVE,
        '--approve-for-me',
        ...BUILDER.turn.args.slice(1),
      ],
      requestedMode: 'auto-review',
      unmet: [],
    },
  },
  client: {
    supervised: { args: [...BUILDER.client.args, ...QUIET], requestedMode: null, unmet: [] },
    autonomous: { args: [...BUILDER.client.args, ...QUIET], requestedMode: null, unmet: [] },
  },
}

describe('codexPosture', () => {
  it.each([
    'terminal',
    'engine',
    'turn',
    'client',
  ] as const)('managed %s launches hide the update prompt and keep the daemon defaults', (mode) => {
    const external = request(mode, SUPERVISED)
    const managed: PostureRequest = {
      ...external,
      context: {
        ...external.context,
        installation: { ...external.context.installation, provenance: 'managed' },
      },
    }
    const before = codexPosture(BUILDER[mode], external)
    const after = applyTerms(BUILDER[mode], launchTerms(codexManifest, managed))
    expect(after.launch.args.filter((arg) => arg === QUIET[1])).toHaveLength(1)
    // External terminal/client already quiet this menu. Engine/turn keep
    // their previous behavior on the person's own installation.
    expect(before.launch.args.filter((arg) => arg === QUIET[1])).toHaveLength(
      mode === 'terminal' || mode === 'client' ? 1 : 0,
    )
    expect(after.launch.env).toEqual(before.launch.env)
    expect(after.homeEdits).toEqual(before.homeEdits)
    expect(after.launch.args).not.toContain('--no-daemon')
    expect(after.launch.args).not.toContain('--stdio')
    expect(after.launch.args.join(' ')).not.toContain('autoUpdateEnabled')
  })

  for (const mode of LAUNCH_MODES) {
    for (const level of ['supervised', 'autonomous'] as const) {
      it(`${mode} / ${level}`, () => {
        const out = codexPosture(BUILDER[mode], request(mode, { mode: level }))
        const want = EXPECTED[mode][level]
        expect(out.launch.args).toEqual(want.args)
        expect(out.launch.env).toEqual(BUILDER[mode].env)
        expect(out.launch.files).toEqual([])
        expect(out.homeEdits).toEqual([RULE_EDIT])
        expect(out.requestedMode).toBe(want.requestedMode)
        expect(out.unmet).toEqual(want.unmet)
      })
    }
  }

  it('passes every launch mode through applyTerms: it only adds', () => {
    for (const mode of LAUNCH_MODES) {
      for (const posture of [SUPERVISED, AUTONOMOUS]) {
        const out = applyTerms(BUILDER[mode], launchTerms(codexManifest, request(mode, posture)))
        expect(out.launch.args).toEqual(EXPECTED[mode][posture.mode as 'supervised'].args)
        expect(out.applied.homeEdits).toEqual([RULE_EDIT])
      }
    }
  })

  it('trusts the working folder when it is not a worktree', () => {
    const out = codexPosture(
      BUILDER.terminal,
      request('terminal', AUTONOMOUS, { repoRoot: undefined }),
    )
    expect(projectsArgs(out.launch.args)).toEqual([
      `projects={"${WORKDIR}"={trust_level="trusted"}}`,
    ])
  })

  describe('a worktree session (POD-7039)', () => {
    // The engine of a worktree session must trust the worktree: the CLI-tab
    // client runs `resume -C <worktree> --remote`, and the engine checks that
    // folder literally, so trusting only the main checkout drew "Trust this
    // folder?" in the client (measured, POD-6867).
    for (const mode of ['terminal', 'engine', 'turn'] as const) {
      it(`${mode}: trusts the main checkout and the worktree, in one table`, () => {
        const out = codexPosture(BUILDER[mode], request(mode, SUPERVISED))
        expect(projectsArgs(out.launch.args)).toEqual([TRUST[1]])
      })
    }

    it('client: takes no trust of its own; the engine it joins decides', () => {
      const out = codexPosture(BUILDER.client, request('client', SUPERVISED))
      expect(projectsArgs(out.launch.args)).toEqual([])
    })

    it('names a folder once when the root and the working folder are the same', () => {
      const out = codexPosture(
        BUILDER.engine,
        request('engine', SUPERVISED, { workdir: REPO_ROOT, repoRoot: REPO_ROOT }),
      )
      expect(projectsArgs(out.launch.args)).toEqual([
        `projects={"${REPO_ROOT}"={trust_level="trusted"}}`,
      ])
    })
  })

  it('writes the rule in the CODEX_HOME the context selected', () => {
    const context = testHarnessContext({
      kind: 'codex',
      home: HOME,
      version: '0.167.2',
      env: { CODEX_HOME: '/srv/codex-home' },
    })
    const out = codexPosture(BUILDER.terminal, request('terminal', AUTONOMOUS, { context }))
    expect(out.homeEdits).toEqual([{ ...RULE_EDIT, file: '/srv/codex-home/rules/podium.rules' }])
  })

  it('names the CLI the grants name in the rule', () => {
    const base = request('terminal', AUTONOMOUS)
    const out = codexPosture(BUILDER.terminal, {
      ...base,
      grants: { ...base.grants, podiumCli: { name: 'podium-dev', path: '/x/podium-dev' } },
    })
    expect(out.homeEdits[0]).toMatchObject({
      contents: expect.stringContaining('prefix_rule(pattern = ["podium-dev"], decision = "allow"'),
    })
  })

  describe('below the version that has automatic review', () => {
    for (const mode of ['terminal', 'engine', 'turn'] as const) {
      it(`${mode}: autonomous gives the supervised output and names the version`, () => {
        const out = codexPosture(BUILDER[mode], request(mode, AUTONOMOUS, { version: '0.146.0' }))
        const supervised = EXPECTED[mode].supervised
        expect(out.launch.args).toEqual(supervised.args)
        expect(out.requestedMode).toBe(supervised.requestedMode)
        expect(out.unmet).toEqual([
          ...supervised.unmet,
          {
            requirement: 'autonomy',
            reason: 'Codex 0.146.0 has no automatic review; it arrived in 0.147.0',
          },
          ...(mode === 'terminal' ? [hookReviewUnmet('version "0.146.0"')] : []),
        ])
      })
    }
  })

  describe('hook review at startup (POD-6999)', () => {
    it('terminal: from 0.147.0 the hook install trusts Podium handlers per launch; nothing unmet', () => {
      for (const version of ['0.147.0', '0.167.2', '0.169.0', '1.0.0']) {
        const out = codexPosture(BUILDER.terminal, request('terminal', SUPERVISED, { version }))
        expect(out.unmet).toEqual([])
      }
    })

    it('terminal: below 0.147.0 or with an unknown version, quiet start is unmet', () => {
      for (const [version, named] of [
        ['0.146.9', 'version "0.146.9"'],
        ['', 'of unknown version'],
        ['codex-cli dev', 'version "codex-cli dev"'],
      ] as const) {
        const out = codexPosture(BUILDER.terminal, request('terminal', SUPERVISED, { version }))
        expect(out.unmet).toEqual([hookReviewUnmet(named)])
      }
    })

    it('engine and turn report no quiet-start entry for hooks: neither draws a screen', () => {
      for (const mode of ['engine', 'turn'] as const) {
        const out = codexPosture(BUILDER[mode], request(mode, AUTONOMOUS, { version: '' }))
        expect(out.unmet.map((entry) => entry.requirement)).not.toContain('quiet-start')
      }
    })

    it('client (POD-7028): the engine it joins decides hook review; from 0.147.0 nothing is unmet', () => {
      // Measured, 0.169.0: a `resume --remote` client draws "Hooks need review"
      // against an engine without the override, whatever the client is given,
      // and none against an engine with it.
      for (const version of ['0.147.0', '0.169.0']) {
        const out = codexPosture(BUILDER.client, request('client', SUPERVISED, { version }))
        expect(out.unmet).toEqual([])
        expect(out.launch.args.join(' ')).not.toContain('hooks.state')
      }
    })

    it('client (POD-7028): below 0.147.0 or with an unknown version, quiet start is unmet', () => {
      for (const [version, named] of [
        ['0.146.9', 'version "0.146.9"'],
        ['', 'of unknown version'],
      ] as const) {
        const out = codexPosture(BUILDER.client, request('client', SUPERVISED, { version }))
        expect(out.unmet).toContainEqual(hookReviewUnmet(named))
      }
    })

    it('agrees with the version predicate the hook install uses', () => {
      expect(codexLaunchHookTrustSupported('0.147.0')).toBe(true)
      expect(codexLaunchHookTrustSupported('codex-cli 0.169.0')).toBe(true)
      expect(codexLaunchHookTrustSupported('0.146.9')).toBe(false)
      expect(codexLaunchHookTrustSupported('')).toBe(false)
    })
  })

  describe('a native mode', () => {
    it('passes a Codex approval policy through as itself', () => {
      const native: SessionPosture = { mode: { native: 'never' } }
      expect(codexPosture(BUILDER.terminal, request('terminal', native)).launch.args).toEqual([
        ...EXPECTED.terminal.supervised.args.slice(0, 12),
        '-a',
        'never',
        '--',
        '-a prompt',
      ])
      const engine = codexPosture(BUILDER.engine, request('engine', native))
      expect(engine.launch.args.slice(-2)).toEqual(['-c', 'approval_policy="never"'])
      expect(engine.requestedMode).toBe('never')
      const turn = codexPosture(BUILDER.turn, request('turn', native))
      expect(turn.launch.args).toEqual([
        'exec',
        ...TRUST,
        ...NETWORK,
        ...MCP_APPROVE,
        '-c',
        'approval_policy="never"',
        ...BUILDER.turn.args.slice(1),
      ])
      expect(turn.unmet).toEqual([])
    })

    it('maps on-request and auto-review onto the two levels', () => {
      for (const mode of ['terminal', 'engine', 'turn'] as const) {
        expect(
          codexPosture(BUILDER[mode], request(mode, { mode: { native: 'auto-review' } })).launch
            .args,
        ).toEqual(EXPECTED[mode].autonomous.args)
        expect(
          codexPosture(BUILDER[mode], request(mode, { mode: { native: 'on-request' } })).launch
            .args,
        ).toEqual(EXPECTED[mode].supervised.args)
      }
    })

    it('reports a word Codex does not have as unmet autonomy and adds no mode flag', () => {
      const out = codexPosture(BUILDER.terminal, request('terminal', { mode: { native: 'plan' } }))
      expect(out.launch.args).toEqual([
        ...EXPECTED.terminal.supervised.args.slice(0, 12),
        '--',
        '-a prompt',
      ])
      expect(out.requestedMode).toBeNull()
      expect(out.unmet).toEqual([
        {
          requirement: 'autonomy',
          reason:
            'Codex has no approval mode named "plan", so it starts in the mode its own settings choose',
        },
      ])
    })
  })

  describe('the folder in the inline TOML value (Review Focus 4)', () => {
    it('escapes a quote and keeps a space and a non-ASCII letter', () => {
      const out = codexPosture(
        BUILDER.engine,
        request('engine', AUTONOMOUS, {
          repoRoot: '/tmp/a "b"/c é',
          workdir: '/tmp/a "b"/c é/.worktrees/ü "x" y',
        }),
      )
      expect(projectsArgs(out.launch.args)).toEqual([
        'projects={"/tmp/a \\"b\\"/c é"={trust_level="trusted"},"/tmp/a \\"b\\"/c é/.worktrees/ü \\"x\\" y"={trust_level="trusted"}}',
      ])
    })

    it('escapes the backslashes of a Windows path', () => {
      const out = codexPosture(
        BUILDER.engine,
        request('engine', AUTONOMOUS, {
          repoRoot: 'C:\\Users\\a b\\repo',
          workdir: 'C:\\Users\\a b\\repo\\.worktrees\\issue-1',
        }),
      )
      expect(projectsArgs(out.launch.args)).toEqual([
        'projects={"C:\\\\Users\\\\a b\\\\repo"={trust_level="trusted"},"C:\\\\Users\\\\a b\\\\repo\\\\.worktrees\\\\issue-1"={trust_level="trusted"}}',
      ])
    })

    it('escapes control characters TOML does not allow raw', () => {
      const out = codexPosture(
        BUILDER.terminal,
        request('terminal', AUTONOMOUS, { repoRoot: undefined, workdir: '/tmp/tab\there\u007f' }),
      )
      expect(projectsArgs(out.launch.args)).toEqual([
        'projects={"/tmp/tab\\there\\u007F"={trust_level="trusted"}}',
      ])
    })
  })

  it('approves only the Podium servers this launch mounts', () => {
    const out = codexPosture(BUILDER.engine, request('engine', SUPERVISED))
    const approvals = out.launch.args.filter((arg) => arg.includes('default_tools_approval_mode'))
    expect(approvals).toEqual(['mcp_servers."podium".default_tools_approval_mode="approve"'])
  })
})
