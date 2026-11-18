/**
 * Cursor's launch terms (POD-6858 Task 7; docs/design/harness-session-posture.md
 * §4.8): the exact args, env, files, home edits, requested mode and unmet
 * entries for every launch mode and mode level. Cursor's row is documented,
 * not measured, so most of what it cannot be shown to meet is reported.
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
import { cursorManifest } from './index.js'
import { cursorPosture } from './posture.js'

const RUNTIME_DIR = '/run/podium/sessions/s1'

function request(mode: LaunchMode, posture: SessionPosture): PostureRequest {
  return {
    mode,
    posture,
    grants: {
      podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
      uploadsDir: '/var/lib/podium/uploads/s1',
      mcpServers: ['podium'],
    },
    workdir: '/work/repo',
    runtimeDir: RUNTIME_DIR,
    context: testHarnessContext({ kind: 'cursor', version: '2026.07.23' }),
  }
}

const SUPERVISED: SessionPosture = { mode: 'supervised' }
const AUTONOMOUS: SessionPosture = { mode: 'autonomous' }

/** What each launch builder emits. Cursor has no engine and no client; their
 *  rows are the shapes a turn and a terminal take, for conformance. */
const BUILDER: Record<LaunchMode, PostureLaunch> = {
  // `launch()`: a resume with the session's instruction plugin.
  terminal: {
    args: ['--resume', 'chat-1', '--plugin-dir', RUNTIME_DIR],
    env: {},
    files: [{ path: `${RUNTIME_DIR}/rules/podium-session-context.mdc`, contents: 'x' }],
  },
  engine: { args: ['-p', 'hello'], env: {}, files: [] },
  // `headless.buildExec`: the prompt is the last positional.
  turn: { args: ['-p', '--resume', 'chat-1', '--model', 'auto', '-a prompt'], env: {}, files: [] },
  client: { args: ['--resume', 'chat-1'], env: {}, files: [] },
}

const TRUST_REASON =
  'Cursor keeps interactive folder trust in private state that Podium does not write'
const CLI_REASON =
  'Cursor takes allow rules only from a settings file shared with every Cursor session, which Podium does not edit'
const QUIET_REASON = 'unmeasured: no signed-in Cursor account was available to the spike'
const READS_REASON =
  "unmeasured: whether Cursor asks before reading Podium's attachments outside the working folder; no signed-in Cursor account was available to the spike"
const TERMINAL_MODE_REASON =
  "unmeasured: Cursor's mode flags were not run in its terminal UI (no signed-in Cursor account was available to the spike), so it starts in the mode its own settings choose"

describe('cursorPosture', () => {
  it('turn / supervised: --trust before the prompt; the allowlist mode needs no flag', () => {
    const out = cursorPosture(BUILDER.turn, request('turn', SUPERVISED))
    expect(out.launch).toEqual({
      args: ['-p', '--resume', 'chat-1', '--model', 'auto', '--trust', '-a prompt'],
      env: {},
      files: [],
    })
    expect(out.homeEdits).toEqual([])
    expect(out.requestedMode).toBe('allowlist')
    expect(out.unmet).toEqual([
      { requirement: 'podium-cli', reason: CLI_REASON },
      { requirement: 'podium-material', reason: READS_REASON },
    ])
  })

  it('turn / autonomous: --trust and --auto-review before the prompt', () => {
    const out = cursorPosture(BUILDER.turn, request('turn', AUTONOMOUS))
    expect(out.launch.args).toEqual([
      '-p',
      '--resume',
      'chat-1',
      '--model',
      'auto',
      '--trust',
      '--auto-review',
      '-a prompt',
    ])
    expect(out.homeEdits).toEqual([])
    expect(out.requestedMode).toBe('auto-review')
    expect(out.unmet).toEqual([
      { requirement: 'podium-cli', reason: CLI_REASON },
      { requirement: 'podium-material', reason: READS_REASON },
    ])
  })

  for (const posture of [SUPERVISED, AUTONOMOUS]) {
    it(`terminal / ${posture.mode}: no flag; trust, the CLI, quiet start, reads and the mode are unmet`, () => {
      const out = cursorPosture(BUILDER.terminal, request('terminal', posture))
      expect(out.launch).toEqual(BUILDER.terminal)
      expect(out.homeEdits).toEqual([])
      expect(out.requestedMode).toBeNull()
      expect(out.unmet).toEqual([
        { requirement: 'workspace-trust', reason: TRUST_REASON },
        { requirement: 'podium-cli', reason: CLI_REASON },
        { requirement: 'autonomy', reason: TERMINAL_MODE_REASON },
        { requirement: 'quiet-start', reason: QUIET_REASON },
        { requirement: 'podium-material', reason: READS_REASON },
      ])
    })
  }

  it('never approves MCP servers: Podium mounts none in Cursor, and the flag would approve the repository’s own', () => {
    for (const mode of LAUNCH_MODES) {
      const out = cursorPosture(BUILDER[mode], request(mode, AUTONOMOUS))
      expect(out.launch.args).not.toContain('--approve-mcps')
    }
  })

  it("passes a native pick through when it is one of Cursor's own modes", () => {
    const out = cursorPosture(BUILDER.turn, request('turn', { mode: { native: 'auto-review' } }))
    expect(out.launch.args).toContain('--auto-review')
    expect(out.requestedMode).toBe('auto-review')
  })

  it('reports a native pick Cursor has no mode for as unmet autonomy, and sends no mode flag', () => {
    const out = cursorPosture(BUILDER.turn, request('turn', { mode: { native: 'auto' } }))
    expect(out.launch.args).toEqual([
      '-p',
      '--resume',
      'chat-1',
      '--model',
      'auto',
      '--trust',
      '-a prompt',
    ])
    expect(out.requestedMode).toBeNull()
    expect(out.unmet).toContainEqual({
      requirement: 'autonomy',
      reason:
        'Cursor has no permission mode named "auto", so it starts in the mode its own settings choose',
    })
  })

  it('passes the contract checks in every launch mode', () => {
    for (const mode of LAUNCH_MODES) {
      for (const posture of [SUPERVISED, AUTONOMOUS]) {
        expect(() =>
          applyTerms(BUILDER[mode], launchTerms(cursorManifest, request(mode, posture))),
        ).not.toThrow()
      }
    }
  })
})
