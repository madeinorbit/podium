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
import { codexPosture } from './posture.js'

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

const TRUST = ['-c', 'projects={"/work/repo"={trust_level="trusted"}}']
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
    expect(out.launch.args).toContain(`projects={"${WORKDIR}"={trust_level="trusted"}}`)
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
        ])
      })
    }
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
        BUILDER.terminal,
        request('terminal', AUTONOMOUS, { repoRoot: '/tmp/a "b"/c é' }),
      )
      expect(out.launch.args).toContain('projects={"/tmp/a \\"b\\"/c é"={trust_level="trusted"}}')
    })

    it('escapes the backslashes of a Windows path', () => {
      const out = codexPosture(
        BUILDER.terminal,
        request('terminal', AUTONOMOUS, { repoRoot: 'C:\\Users\\a b\\repo' }),
      )
      expect(out.launch.args).toContain(
        'projects={"C:\\\\Users\\\\a b\\\\repo"={trust_level="trusted"}}',
      )
    })

    it('escapes control characters TOML does not allow raw', () => {
      const out = codexPosture(
        BUILDER.terminal,
        request('terminal', AUTONOMOUS, { repoRoot: '/tmp/tab\there\u007f' }),
      )
      expect(out.launch.args).toContain(
        'projects={"/tmp/tab\\there\\u007F"={trust_level="trusted"}}',
      )
    })
  })

  it('approves only the Podium servers this launch mounts', () => {
    const out = codexPosture(BUILDER.engine, request('engine', SUPERVISED))
    const approvals = out.launch.args.filter((arg) => arg.includes('default_tools_approval_mode'))
    expect(approvals).toEqual(['mcp_servers."podium".default_tools_approval_mode="approve"'])
  })
})
