import { describe, expect, it } from 'vitest'
import { agentStateProviderFor, claudeCodeStateProvider } from './claude-code'

const URL = 'http://127.0.0.1:45777/hooks/s1'

describe('claude-code instrumentation', () => {
  it('injects --settings pointing at the generated file', () => {
    const instr = claudeCodeStateProvider.instrumentation({
      endpointUrl: URL,
      settingsPath: '/tmp/podium/hooks/s1.json',
    })
    expect(instr.args).toEqual(['--settings', '/tmp/podium/hooks/s1.json'])
    expect(instr.file?.path).toBe('/tmp/podium/hooks/s1.json')
  })

  it('settings file is valid JSON wiring every lifecycle event to the http endpoint', () => {
    const instr = claudeCodeStateProvider.instrumentation({ endpointUrl: URL, settingsPath: '/x.json' })
    const settings = JSON.parse(instr.file?.contents ?? '') as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; url: string }[] }[]>
    }
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification',
      'Stop',
      'StopFailure',
      'TaskCreated',
      'TaskCompleted',
      'PreCompact',
      'PostCompact',
      'SessionEnd',
    ]) {
      const groups = settings.hooks[event]
      expect(groups, `missing hooks for ${event}`).toBeDefined()
      for (const g of groups ?? []) {
        expect(g.hooks).toEqual([{ type: 'http', url: URL }])
      }
    }
    // PreToolUse only watches the question tool; Notification only permission prompts.
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion')
    expect(settings.hooks.Notification?.[0]?.matcher).toBe('permission_prompt')
  })
})

describe('agentStateProviderFor', () => {
  it('claude-code gets a provider; codex and shell do not (yet)', () => {
    expect(agentStateProviderFor('claude-code')).toBe(claudeCodeStateProvider)
    expect(agentStateProviderFor('codex')).toBeUndefined()
    expect(agentStateProviderFor('shell')).toBeUndefined()
  })
})
