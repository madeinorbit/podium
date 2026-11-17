// The one constructor of a launchable harness command takes its terms
// (POD-6858, docs/design/harness-session-posture.md §4.6).

import { describe, expect, it } from 'vitest'
import { harnessCommand, throughLauncher, withArgs, withTrailingArgs } from './bound-command.js'
import { testHarnessContext } from './driver/testing/harness-context.js'
import { noAgentTerms, optionArgs, unchangedPosture } from './posture.js'
import type { PostureRequest } from './posture-types.js'

const context = testHarnessContext({ kind: 'codex', home: '/home/podium-test' })
const request: PostureRequest = {
  mode: 'terminal',
  posture: { mode: 'autonomous' },
  grants: {
    podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
    uploadsDir: '/var/lib/podium/uploads/s1',
    mcpServers: [],
  },
  workdir: '/work/repo',
  runtimeDir: '/run/podium/s1',
  context,
}

describe('harnessCommand', () => {
  it('cannot be called without terms', () => {
    // @ts-expect-error: the terms are a required third argument.
    const bare = () => harnessCommand(context, { args: ['--x'] })
    expect(bare).toThrow()
  })

  it('binds a no-agent command with empty terms and the builder launch unchanged', () => {
    const command = harnessCommand(
      context,
      { args: ['login'], env: { A: '1' } },
      noAgentTerms('native login pane: runs no agent'),
    )
    expect(command.cmd).toBe(context.installation.executable)
    expect(command.args).toEqual(['login'])
    expect(command.env).toEqual({ A: '1' })
    expect(command.files).toEqual([])
    expect(command.terms).toEqual({ homeEdits: [], requestedMode: null, unmet: [] })
  })

  it("carries the section's additions and its applied terms, kept by the argv helpers", () => {
    const command = harnessCommand(
      context,
      { args: ['--resume', 'id', '--', 'hello'] },
      {
        request,
        posture: (launch) => ({
          ...unchangedPosture(launch),
          launch: {
            args: optionArgs(launch.args, ['--marker']),
            env: { ...launch.env, MARK: '1' },
            files: [{ path: '/run/podium/s1/marker.json', contents: '{}' }],
          },
          requestedMode: 'auto',
          unmet: [{ requirement: 'quiet-start', reason: 'no switch for the update menu' }],
        }),
      },
    )
    expect(command.args).toEqual(['--resume', 'id', '--marker', '--', 'hello'])
    expect(command.env).toEqual({ MARK: '1' })
    expect(command.files).toEqual([{ path: '/run/podium/s1/marker.json', contents: '{}' }])
    expect(command.terms.requestedMode).toBe('auto')
    expect(withTrailingArgs(command, ['--tail']).terms).toEqual(command.terms)
    expect(withArgs(command, ['x']).terms).toEqual(command.terms)
    expect(throughLauncher(command, { cmd: '/bin/sh', args: ['-c'] }).terms).toEqual(command.terms)
  })
})
