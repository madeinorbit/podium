/**
 * Pi's launch terms (POD-6858 Task 7; docs/design/harness-session-posture.md
 * §4.8): the exact args, env, files, home edits, requested mode and unmet
 * entries for every launch mode and mode level.
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
import { piManifest } from './index.js'
import { piPosture } from './posture.js'

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
    runtimeDir: '/run/podium/sessions/s1',
    context: testHarnessContext({ kind: 'pi', version: '1.5.2' }),
  }
}

const SUPERVISED: SessionPosture = { mode: 'supervised' }
const AUTONOMOUS: SessionPosture = { mode: 'autonomous' }

/** What each launch builder emits. Pi has no engine and no client; their
 *  rows are the shapes a terminal and a turn take, for conformance. */
const BUILDER: Record<LaunchMode, PostureLaunch> = {
  // `launch()`: a resume with a `--` prompt boundary.
  terminal: {
    args: ['--session', 'abc', '--model', 'openai/gpt-5.5', '--', '-a prompt'],
    env: {},
    files: [],
  },
  engine: { args: [], env: {}, files: [] },
  // `headless.buildExec`: the prompt rides stdin.
  turn: { args: ['-p', '--mode', 'json', '--session-id', 'abc'], env: {}, files: [] },
  client: { args: ['--session', 'abc'], env: {}, files: [] },
}

const WITH_APPROVE: Record<LaunchMode, string[]> = {
  terminal: ['--session', 'abc', '--model', 'openai/gpt-5.5', '--approve', '--', '-a prompt'],
  engine: ['--approve'],
  turn: ['-p', '--mode', 'json', '--session-id', 'abc', '--approve'],
  client: ['--session', 'abc', '--approve'],
}

const NO_GATE = 'Pi has no approval gate: it never asks before it runs a tool'

describe('piPosture', () => {
  describe.each(LAUNCH_MODES)('%s managed update notice control', (mode) => {
    it('skips the version check for managed releases and preserves all other launch terms', () => {
      const base = request(mode, AUTONOMOUS)
      const launch = { ...BUILDER[mode], env: { KEEP: 'value', PI_SKIP_VERSION_CHECK: '0' } }
      const external = piPosture(launch, base)
      const managed = piPosture(launch, {
        ...base,
        context: testHarnessContext({ kind: 'pi', version: '1.6.0', provenance: 'managed' }),
      })
      expect(managed).toEqual({
        ...external,
        launch: { ...external.launch, env: { ...launch.env, PI_SKIP_VERSION_CHECK: '1' } },
      })
      expect(external.launch.env).toEqual(launch.env)
      expect(launch.env.PI_SKIP_VERSION_CHECK).toBe('0')
    })

    it('leaves an external installation without an update switch', () => {
      expect(piPosture(BUILDER[mode], request(mode, AUTONOMOUS)).launch.env).toEqual({})
    })
  })

  for (const mode of LAUNCH_MODES) {
    it(`${mode} / autonomous: --approve trusts the folder; nothing unmet`, () => {
      const out = piPosture(BUILDER[mode], request(mode, AUTONOMOUS))
      expect(out.launch).toEqual({ args: WITH_APPROVE[mode], env: {}, files: [] })
      expect(out.homeEdits).toEqual([])
      expect(out.requestedMode).toBeNull()
      expect(out.unmet).toEqual([])
    })

    it(`${mode} / supervised: --approve as well, and autonomy is unmet`, () => {
      const out = piPosture(BUILDER[mode], request(mode, SUPERVISED))
      expect(out.launch).toEqual({ args: WITH_APPROVE[mode], env: {}, files: [] })
      expect(out.homeEdits).toEqual([])
      expect(out.requestedMode).toBeNull()
      expect(out.unmet).toEqual([{ requirement: 'autonomy', reason: NO_GATE }])
    })
  }

  it('reports a native pick as unmet autonomy: Pi has no modes to pick from', () => {
    const out = piPosture(BUILDER.turn, request('turn', { mode: { native: 'auto' } }))
    expect(out.launch.args).toEqual(WITH_APPROVE.turn)
    expect(out.requestedMode).toBeNull()
    expect(out.unmet).toEqual([
      {
        requirement: 'autonomy',
        reason:
          'Pi has no permission mode named "auto": it has no approval gate and never asks before it runs a tool',
      },
    ])
  })

  it('passes the contract checks in every launch mode', () => {
    for (const mode of LAUNCH_MODES) {
      for (const posture of [SUPERVISED, AUTONOMOUS]) {
        expect(() =>
          applyTerms(BUILDER[mode], launchTerms(piManifest, request(mode, posture))),
        ).not.toThrow()
      }
    }
  })
})
