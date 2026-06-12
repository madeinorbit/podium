import { describe, expect, it } from 'vitest'
import { agentStateProviderFor, claudeCodeStateProvider, translateClaudeHookPayload } from './claude-code'

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

const base = { session_id: 'cc1', transcript_path: '/nonexistent.jsonl', cwd: '/tmp' }

describe('translateClaudeHookPayload', () => {
  const t = (extra: Record<string, unknown>) => translateClaudeHookPayload({ ...base, ...extra })

  it('maps lifecycle events', async () => {
    expect(await t({ hook_event_name: 'SessionStart', source: 'startup' })).toEqual([
      { kind: 'session_started' },
    ])
    expect(await t({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toEqual([
      { kind: 'prompt_submitted' },
    ])
    expect(await t({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })).toEqual([
      { kind: 'activity' },
    ])
    expect(await t({ hook_event_name: 'SessionEnd', reason: 'other' })).toEqual([
      { kind: 'session_ended' },
    ])
    expect(await t({ hook_event_name: 'PreCompact', trigger: 'auto' })).toEqual([
      { kind: 'compaction', phase: 'start' },
    ])
    expect(await t({ hook_event_name: 'PostCompact', trigger: 'auto' })).toEqual([
      { kind: 'compaction', phase: 'end' },
    ])
    expect(await t({ hook_event_name: 'TaskCreated' })).toEqual([{ kind: 'task_delta', delta: 1 }])
    expect(await t({ hook_event_name: 'TaskCompleted' })).toEqual([
      { kind: 'task_delta', delta: -1 },
    ])
  })

  it('AskUserQuestion PreToolUse → needs_user question with the question text', async () => {
    const events = await t({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which auth method?', header: 'Auth' }] },
    })
    expect(events).toEqual([{ kind: 'needs_user', need: 'question', summary: 'Which auth method?' }])
  })

  it('non-question PreToolUse is just activity', async () => {
    expect(await t({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toEqual([
      { kind: 'activity' },
    ])
  })

  it('PermissionRequest / Notification → needs_user permission', async () => {
    expect(await t({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toEqual([
      { kind: 'needs_user', need: 'permission', summary: 'Bash' },
    ])
    expect(
      await t({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }),
    ).toEqual([
      { kind: 'needs_user', need: 'permission', summary: 'Claude needs your permission to use Bash' },
    ])
  })

  it('StopFailure → turn_failed; retryable only for transient classes', async () => {
    expect(await t({ hook_event_name: 'StopFailure', error_type: 'rate_limit' })).toEqual([
      { kind: 'turn_failed', errorClass: 'rate_limit', retryable: true },
    ])
    expect(await t({ hook_event_name: 'StopFailure', error_type: 'billing_error' })).toEqual([
      { kind: 'turn_failed', errorClass: 'billing_error', retryable: false },
    ])
    // unknown payload shape → still errored, conservatively retryable
    expect(await t({ hook_event_name: 'StopFailure' })).toEqual([
      { kind: 'turn_failed', errorClass: 'unknown', retryable: true },
    ])
  })

  it('Stop (unreadable transcript) → turn_completed without verdict', async () => {
    expect(await t({ hook_event_name: 'Stop', stop_hook_active: false })).toEqual([
      { kind: 'turn_completed' },
    ])
  })

  it('garbage payloads translate to nothing', async () => {
    expect(await translateClaudeHookPayload(null)).toEqual([])
    expect(await translateClaudeHookPayload('x')).toEqual([])
    expect(await translateClaudeHookPayload({ hook_event_name: 'SomethingNew' })).toEqual([])
  })
})
