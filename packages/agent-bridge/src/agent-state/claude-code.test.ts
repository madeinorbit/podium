import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentStateProviderFor,
  classifyClaudeTranscriptState,
  classifyIdleTranscript,
  claudeCodeStateProvider,
  translateClaudeHookPayload,
} from './claude-code'
import { codexStateProvider } from './codex'
import { grokStateProvider } from './grok'

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
    const instr = claudeCodeStateProvider.instrumentation({
      endpointUrl: URL,
      settingsPath: '/x.json',
    })
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
    // PreToolUse watches every tool (no matcher) so a tool starting reads as
    // working immediately; translate() routes AskUserQuestion → needs_user and
    // the rest → activity. Notification stays scoped to permission prompts.
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBeUndefined()
    expect(settings.hooks.Notification?.[0]?.matcher).toBe('permission_prompt')
  })
})

describe('agentStateProviderFor', () => {
  it('claude-code, grok, codex and opencode get providers; shell does not', () => {
    expect(agentStateProviderFor('claude-code')).toBe(claudeCodeStateProvider)
    expect(agentStateProviderFor('codex')).toBe(codexStateProvider)
    expect(agentStateProviderFor('grok')).toBe(grokStateProvider)
    expect(agentStateProviderFor('opencode')).toBeDefined()
    expect(agentStateProviderFor('cursor')).toBeDefined()
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
    expect(events).toEqual([
      { kind: 'needs_user', need: 'question', summary: 'Which auth method?' },
    ])
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
      await t({
        hook_event_name: 'Notification',
        message: 'Claude needs your permission to use Bash',
      }),
    ).toEqual([
      {
        kind: 'needs_user',
        need: 'permission',
        summary: 'Claude needs your permission to use Bash',
      },
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

const assistantLine = (blocks: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const userLine = (content: unknown) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } })
const text = (t: string) => ({ type: 'text', text: t })

describe('classifyIdleTranscript', () => {
  const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as unknown)

  it('plan mode at stop → approval, regardless of text', () => {
    const records = parse([assistantLine([text('All tests pass.')])])
    expect(classifyIdleTranscript(records, 'plan')).toEqual({
      kind: 'approval',
      summary: 'plan awaiting approval',
    })
  })

  it('terminal Claude interrupt marker → interrupted', () => {
    const records = parse([
      assistantLine([text('Should I continue?')]),
      userLine('[Request interrupted by user]'),
      '{"type":"summary"}',
    ])
    expect(classifyIdleTranscript(records, 'plan')).toEqual({
      kind: 'interrupted',
      summary: 'request interrupted by user',
    })
  })

  it('trailing question → question with the asking line as summary', () => {
    const records = parse([
      assistantLine([text('Done with part one.')]),
      assistantLine([text('I can use JWT or sessions.\nWhich approach do you prefer?')]),
    ])
    expect(classifyIdleTranscript(records, 'default')).toEqual({
      kind: 'question',
      summary: 'Which approach do you prefer?',
    })
  })

  it('optional follow-up language does not require input by itself', () => {
    const records = parse([
      assistantLine([text('Let me know if you want me to also update the docs')]),
    ])
    expect(classifyIdleTranscript(records, 'default')?.kind).toBe('done')
  })

  it('completed work plus optional follow-up is finished', () => {
    const records = parse([assistantLine([text('Done. Tests pass. Want me to push?')])])
    expect(classifyClaudeTranscriptState(records, 'default')).toMatchObject({
      status: 'resolved',
      label: 'idle.finished',
    })
  })

  it('ambiguous terminal question is marked for semantic classification internally', () => {
    const records = parse([
      userLine('Plan the migration'),
      assistantLine([text('There are two viable paths. Should we use A or B?')]),
    ])
    expect(classifyClaudeTranscriptState(records, 'default')).toMatchObject({
      status: 'needs_semantic_classification',
      candidateLabels: expect.arrayContaining(['idle.needs_input.text_question', 'idle.finished']),
    })
  })

  it('declarative ending → done', () => {
    const records = parse([assistantLine([text('Committed. All 42 tests pass.')])])
    expect(classifyIdleTranscript(records, 'default')).toEqual({ kind: 'done' })
  })

  it('unresolved trailing tool-use-only assistant records are working internally', () => {
    const records = parse([
      assistantLine([text('Should I delete the legacy table?')]),
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    ])
    expect(classifyIdleTranscript(records, 'default')).toBeUndefined()
    expect(classifyClaudeTranscriptState(records, 'default')).toMatchObject({
      status: 'resolved',
      label: 'working.waiting_on_shell',
    })
  })

  it('no assistant text at all → undefined', () => {
    expect(classifyIdleTranscript(parse(['{"type":"summary"}']), 'default')).toBeUndefined()
    expect(classifyIdleTranscript([], 'default')).toBeUndefined()
  })
})

describe('Stop payload end-to-end with a real transcript file', () => {
  it('reads the tail and classifies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-agent-state-'))
    const transcript = join(dir, 't.jsonl')
    await writeFile(
      transcript,
      [
        '{"type":"user","message":{"role":"user","content":"hi"}}',
        assistantLine([text('Want me to proceed with the migration?')]),
      ].join('\n'),
    )
    const events = await translateClaudeHookPayload({
      hook_event_name: 'Stop',
      transcript_path: transcript,
      permission_mode: 'default',
      stop_hook_active: false,
    })
    expect(events).toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'question', summary: 'Want me to proceed with the migration?' },
      },
    ])
  })

  it('does not run semantic classification for ambiguous stopped turns yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-agent-state-'))
    const transcript = join(dir, 't.jsonl')
    await writeFile(
      transcript,
      [
        '{"type":"user","message":{"role":"user","content":"Plan the migration"}}',
        assistantLine([text('There are two viable paths. Should we use A or B?')]),
      ].join('\n'),
    )
    const events = await translateClaudeHookPayload({
      hook_event_name: 'Stop',
      transcript_path: transcript,
      permission_mode: 'default',
      stop_hook_active: false,
    })
    expect(events).toEqual([{ kind: 'turn_completed' }])
  })

  it('classifies a terminal interrupt marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-agent-state-'))
    const transcript = join(dir, 't.jsonl')
    await writeFile(
      transcript,
      [
        assistantLine([text('I can continue with the migration.')]),
        userLine([{ type: 'text', text: '[Request interrupted by user]' }]),
      ].join('\n'),
    )
    const events = await translateClaudeHookPayload({
      hook_event_name: 'Stop',
      transcript_path: transcript,
      permission_mode: 'default',
      stop_hook_active: false,
    })
    expect(events).toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'interrupted', summary: 'request interrupted by user' },
      },
    ])
  })
})

describe('bootEvents', () => {
  it('fresh spawn → session_started (idle, no verdict)', async () => {
    const events = await claudeCodeStateProvider.bootEvents?.({ cwd: '/proj' })
    expect(events).toEqual([{ kind: 'session_started' }])
  })

  it('resume → classifies the resumed transcript tail (question pending)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-boot-home-'))
    const cwd = '/home/dev/my.app'
    const projectDir = join(home, '.claude', 'projects', '-home-dev-my-app')
    await mkdir(projectDir, { recursive: true })
    const transcript = join(projectDir, 'conv1.jsonl')
    await writeFile(
      transcript,
      assistantLine([text('Should I also migrate the staging database?')]),
    )
    // The transcript's mtime (last write = last activity) is the boot event-time, so
    // re-seeding an idle session on reattach restores its real recency, not "now".
    const { mtime } = await stat(transcript)
    const events = await claudeCodeStateProvider.bootEvents?.({
      cwd,
      resumeValue: 'conv1',
      homeDir: home,
    })
    expect(events).toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'question', summary: 'Should I also migrate the staging database?' },
        at: mtime.toISOString(),
      },
    ])
  })

  it('resume with a missing/unclassifiable transcript falls back to session_started', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-boot-home-'))
    const events = await claudeCodeStateProvider.bootEvents?.({
      cwd: '/proj',
      resumeValue: 'nope',
      homeDir: home,
    })
    expect(events).toEqual([{ kind: 'session_started' }])
  })
})
