import { agentLaunchCommand, agentStateProviderFor } from '@podium/harness'
import { describe, expect, it } from 'vitest'
import { instrumentedLaunchArgs } from './session'

function instrumentationArgs(agentKind: 'claude-code' | 'codex'): string[] {
  return agentStateProviderFor(agentKind)!.instrumentation({
    endpointUrl: 'http://127.0.0.1/hooks/s1',
    settingsPath: '/tmp/podium/s1.json',
    seedTheme: true,
  }).args
}

describe('final daemon launch arguments', () => {
  it('keeps Codex theme instrumentation before the protected initial prompt', () => {
    const prompt = '- audit the workspace'
    const launch = agentLaunchCommand('codex', {
      cwd: '/repo',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      initialPrompt: prompt,
    })

    expect(instrumentedLaunchArgs(launch.args, instrumentationArgs('codex'))).toEqual([
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=xhigh',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-c',
      'tui.theme=ansi',
      '--',
      prompt,
    ])
  })

  it('keeps Claude settings before the protected initial prompt', () => {
    const prompt = '--help is task text'
    const launch = agentLaunchCommand('claude-code', { cwd: '/repo', initialPrompt: prompt })

    expect(instrumentedLaunchArgs(launch.args, instrumentationArgs('claude-code'))).toEqual([
      '--settings',
      '/tmp/podium/s1.json',
      '--',
      prompt,
    ])
  })

  it('preserves append order when a launch has no option boundary', () => {
    expect(instrumentedLaunchArgs(['resume', 'session-1'], ['--settings', '/tmp/s1.json'])).toEqual(
      ['resume', 'session-1', '--settings', '/tmp/s1.json'],
    )
  })
})
