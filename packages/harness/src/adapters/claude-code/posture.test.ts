/**
 * Claude Code's launch terms (POD-6858 Task 4; docs/design/
 * harness-session-posture.md §4.8): the exact args, env, files, home edits,
 * requested mode and unmet entries for every launch mode and mode level.
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
import { claudeCodeManifest } from './index.js'
import { claudeCodePosture } from './posture.js'

const HOME = '/home/podium-test'
const WORKDIR = '/work/repo/.worktrees/issue-1'
const REPO_ROOT = '/work/repo'
const RUNTIME_DIR = '/run/podium/sessions/s1'
const UPLOADS = '/var/lib/podium/uploads/s1'

const context = testHarnessContext({ kind: 'claude-code', home: HOME, version: '2.1.322' })

function request(
  mode: LaunchMode,
  posture: SessionPosture,
  over: Partial<PostureRequest> = {},
): PostureRequest {
  return {
    mode,
    posture,
    grants: {
      podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
      uploadsDir: UPLOADS,
      mcpServers: ['podium', 'issue tracker'],
    },
    workdir: WORKDIR,
    repoRoot: REPO_ROOT,
    runtimeDir: RUNTIME_DIR,
    context,
    ...over,
  }
}

/** A resume launch with a `--` prompt boundary: what the terminal builder emits. */
const resumeLaunch: PostureLaunch = {
  args: ['--resume', 'native-id', '--model', 'opus', '--', '-a prompt that looks like a flag'],
  env: { PODIUM_SESSION: 's1' },
  files: [],
}

/** The rules every Claude launch carries, as one `=`-form flag each. */
const RULE_FLAGS = [
  '--allowedTools=Bash(podium *)',
  '--allowedTools=PowerShell(podium *)',
  `--allowedTools=Read(/${UPLOADS}/**)`,
  '--allowedTools=mcp__podium',
  '--allowedTools=mcp__issue_tracker',
]

const TRUST_EDIT = {
  kind: 'json-key',
  file: `${HOME}/.claude.json`,
  path: ['projects', REPO_ROOT, 'hasTrustDialogAccepted'],
  value: true,
  serves: 'workspace-trust',
} as const

const LEVELS = [
  { posture: { mode: 'supervised' } as SessionPosture, word: 'default' },
  { posture: { mode: 'autonomous' } as SessionPosture, word: 'auto' },
]

describe('claudeCodePosture', () => {
  for (const mode of LAUNCH_MODES) {
    for (const { posture, word } of LEVELS) {
      it(`${mode} / ${posture.mode as string}: --permission-mode ${word}, the rules, the trust key`, () => {
        const out = claudeCodePosture(resumeLaunch, request(mode, posture))
        expect(out.launch.args).toEqual([
          '--resume',
          'native-id',
          '--model',
          'opus',
          '--permission-mode',
          word,
          ...RULE_FLAGS,
          '--',
          '-a prompt that looks like a flag',
        ])
        expect(out.launch.env).toEqual(
          mode === 'terminal'
            ? { PODIUM_SESSION: 's1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1' }
            : { PODIUM_SESSION: 's1' },
        )
        expect(out.launch.files).toEqual([])
        expect(out.homeEdits).toEqual([TRUST_EDIT])
        expect(out.requestedMode).toBe(word)
        expect(out.unmet).toEqual([])
      })
    }
  }

  it('appends after the last option when the launch has no prompt boundary', () => {
    const out = claudeCodePosture(
      { args: ['-p', '--verbose'], env: {}, files: [] },
      request('turn', { mode: 'autonomous' }),
    )
    expect(out.launch.args).toEqual(['-p', '--verbose', '--permission-mode', 'auto', ...RULE_FLAGS])
  })

  it('passes a native Claude mode through as its own word', () => {
    for (const native of [
      'plan',
      'acceptEdits',
      'dontAsk',
      'bypassPermissions',
      'default',
      'auto',
    ]) {
      const out = claudeCodePosture(resumeLaunch, request('engine', { mode: { native } }))
      expect(out.launch.args.slice(4, 6)).toEqual(['--permission-mode', native])
      expect(out.requestedMode).toBe(native)
      expect(out.unmet).toEqual([])
    }
  })

  it('reports a native word Claude does not have as unmet autonomy and asks for no mode', () => {
    const out = claudeCodePosture(resumeLaunch, request('engine', { mode: { native: 'yolo' } }))
    expect(out.launch.args).not.toContain('--permission-mode')
    expect(out.launch.args).toEqual([
      '--resume',
      'native-id',
      '--model',
      'opus',
      ...RULE_FLAGS,
      '--',
      '-a prompt that looks like a flag',
    ])
    expect(out.requestedMode).toBeNull()
    expect(out.unmet).toEqual([
      { requirement: 'autonomy', reason: expect.stringContaining('yolo') },
    ])
  })

  it('keys trust on the working folder when it is not a worktree', () => {
    const out = claudeCodePosture(resumeLaunch, {
      ...request('terminal', { mode: 'autonomous' }),
      repoRoot: undefined,
    })
    expect(out.homeEdits).toEqual([
      { ...TRUST_EDIT, path: ['projects', WORKDIR, 'hasTrustDialogAccepted'] },
    ])
  })

  it('edits the .claude.json Claude reads: under CLAUDE_CONFIG_DIR when the context selects one', () => {
    const selected = testHarnessContext({
      kind: 'claude-code',
      home: HOME,
      env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude` },
    })
    const out = claudeCodePosture(
      resumeLaunch,
      request('engine', { mode: 'autonomous' }, { context: selected }),
    )
    // Podium's own agent home: the file may be created on the first launch.
    expect(out.homeEdits).toStrictEqual([
      { ...TRUST_EDIT, file: `${HOME}/.claude/.claude.json`, createIfMissing: true },
    ])
  })

  it("never creates the person's own ~/.claude.json", () => {
    for (const mode of LAUNCH_MODES) {
      const out = claudeCodePosture(resumeLaunch, request(mode, { mode: 'autonomous' }))
      expect(out.homeEdits).toStrictEqual([TRUST_EDIT])
      expect(out.homeEdits[0]).not.toHaveProperty('createIfMissing')
    }
  })

  it('keeps a folder path with a space, a quote and non-ASCII as one argv token per rule', () => {
    const uploads = `/var/lib/pod ium/up"loads/sé's 文件`
    const out = claudeCodePosture(
      { args: ['--', 'hi'], env: {}, files: [] },
      request(
        'terminal',
        { mode: 'autonomous' },
        {
          grants: {
            podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
            uploadsDir: uploads,
            mcpServers: [],
          },
          repoRoot: `/work/my "repo" é`,
        },
      ),
    )
    expect(out.launch.args).toEqual([
      '--permission-mode',
      'auto',
      '--allowedTools=Bash(podium *)',
      '--allowedTools=PowerShell(podium *)',
      `--allowedTools=Read(/${uploads}/**)`,
      '--',
      'hi',
    ])
    expect(out.homeEdits[0]).toMatchObject({
      path: ['projects', `/work/my "repo" é`, 'hasTrustDialogAccepted'],
    })
  })

  it('writes a Windows uploads folder in the POSIX form Claude matches read rules in', () => {
    const out = claudeCodePosture(
      { args: [], env: {}, files: [] },
      request(
        'terminal',
        { mode: 'autonomous' },
        {
          grants: {
            podiumCli: { name: 'podium', path: 'C:\\podium\\podium.exe' },
            uploadsDir: 'C:\\Users\\me\\AppData\\podium\\uploads\\s1\\',
            mcpServers: [],
          },
        },
      ),
    )
    expect(out.launch.args).toContain(
      '--allowedTools=Read(//c/Users/me/AppData/podium/uploads/s1/**)',
    )
  })

  it('keeps the contract applyTerms checks, in every mode', () => {
    for (const mode of LAUNCH_MODES) {
      const out = applyTerms(
        resumeLaunch,
        launchTerms(claudeCodeManifest, request(mode, { mode: 'supervised' })),
      )
      expect(out.applied.requestedMode).toBe('default')
      expect(out.applied.homeEdits).toEqual([TRUST_EDIT])
    }
  })
})
