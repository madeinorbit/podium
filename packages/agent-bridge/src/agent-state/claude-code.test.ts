import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentStateProviderFor } from '../harness/registry.js'
import {
  classifyClaudeTranscriptState,
  classifyIdleTranscript,
  claudeCodeStateProvider,
  translateClaudeHookPayload,
} from './claude-code'
import { codexStateProvider } from './codex'
import { grokStateProvider } from './grok'
import { initialAgentState, reduceAgentState } from './reducer'

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

  it('seedTheme writes theme:auto into the per-session settings; off/absent leaves the key out [spec:SP-a04d]', () => {
    const parse = (seedTheme?: boolean) =>
      JSON.parse(
        claudeCodeStateProvider.instrumentation({
          endpointUrl: URL,
          settingsPath: '/x.json',
          ...(seedTheme === undefined ? {} : { seedTheme }),
        }).file?.contents ?? '',
      ) as { theme?: string; hooks: unknown }
    expect(parse(true).theme).toBe('auto')
    // Off or absent = the user's native theme behaviour, untouched.
    expect(parse(false).theme).toBeUndefined()
    expect(parse().theme).toBeUndefined()
    // Hooks wiring is identical in both modes.
    expect(parse(true).hooks).toEqual(parse(false).hooks)
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
      'SubagentStart',
      'SubagentStop',
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

  it('SubagentStart/Stop carry agent_id + agent_type into task_delta', async () => {
    // Captured shape (Claude 2.1.212): SubagentStart/Stop include agent_id +
    // agent_type; parent session_id is shared (no separate subagent session).
    expect(
      await t({
        hook_event_name: 'SubagentStart',
        agent_id: 'ad7e66922f0d8ff7a',
        agent_type: 'Explore',
      }),
    ).toEqual([
      {
        kind: 'task_delta',
        delta: 1,
        agentId: 'ad7e66922f0d8ff7a',
        agentType: 'Explore',
      },
    ])
    expect(
      await t({
        hook_event_name: 'SubagentStop',
        agent_id: 'ad7e66922f0d8ff7a',
        agent_type: 'Explore',
        agent_transcript_path: '/tmp/subagents/agent-ad7e66922f0d8ff7a.jsonl',
      }),
    ).toEqual([
      {
        kind: 'task_delta',
        delta: -1,
        agentId: 'ad7e66922f0d8ff7a',
        agentType: 'Explore',
      },
    ])
  })

  it('SubagentStart without agent_id still emits anonymous task_delta', async () => {
    expect(await t({ hook_event_name: 'SubagentStart' })).toEqual([
      { kind: 'task_delta', delta: 1 },
    ])
  })

  it('real SubagentStart/Stop payloads rewire count + identity (Phase-1 capture)', async () => {
    // Exact fields from live Claude 2.1.212 capture (Explore Task spawn).
    // TaskCreated/TaskCompleted never arrived — these hooks own the count.
    const capturedStart = {
      session_id: '5c3c0a43-fb06-4131-acb5-728e8ab8f524',
      transcript_path: '/tmp/5c3c0a43-fb06-4131-acb5-728e8ab8f524.jsonl',
      cwd: '/tmp',
      prompt_id: 'a35a709c-b91a-45a6-aa11-4c85f294d6c0',
      agent_id: 'ad7e66922f0d8ff7a',
      agent_type: 'Explore',
      hook_event_name: 'SubagentStart',
    }
    const capturedStop = {
      session_id: '5c3c0a43-fb06-4131-acb5-728e8ab8f524',
      transcript_path: '/tmp/5c3c0a43-fb06-4131-acb5-728e8ab8f524.jsonl',
      cwd: '/tmp',
      prompt_id: 'a35a709c-b91a-45a6-aa11-4c85f294d6c0',
      permission_mode: 'bypassPermissions',
      agent_id: 'ad7e66922f0d8ff7a',
      agent_type: 'Explore',
      hook_event_name: 'SubagentStop',
      agent_transcript_path:
        '/tmp/5c3c0a43-fb06-4131-acb5-728e8ab8f524/subagents/agent-ad7e66922f0d8ff7a.jsonl',
      last_assistant_message: 'PONG',
    }

    let state = reduceAgentState(
      initialAgentState('2026-07-18T00:00:00.000Z'),
      { kind: 'prompt_submitted' },
      '2026-07-18T00:00:00.000Z',
    )
    for (const event of await translateClaudeHookPayload(capturedStart)) {
      state = reduceAgentState(state, event, '2026-07-18T00:00:01.000Z')
    }
    // Count rewire: was always 0 before (TaskCreated dead); now moves with real hooks.
    expect(state.nativeSubagentCount).toBe(1)
    expect(state.nativeSubagents).toEqual([{ id: 'ad7e66922f0d8ff7a', type: 'Explore' }])
    expect(state.nativeSubagentCount).toBe(state.nativeSubagents?.length ?? 0)

    // M4 debounce gate: turn_completed while subagent live stays working.
    state = reduceAgentState(state, { kind: 'turn_completed' }, '2026-07-18T00:00:02.000Z')
    expect(state).toMatchObject({
      phase: 'working',
      awaitingSubagents: true,
      nativeSubagentCount: 1,
    })

    for (const event of await translateClaudeHookPayload(capturedStop)) {
      state = reduceAgentState(state, event, '2026-07-18T00:00:03.000Z')
    }
    expect(state.nativeSubagentCount).toBe(0)
    expect(state.nativeSubagents).toBeUndefined()
    expect(state).toMatchObject({ phase: 'idle', idle: { kind: 'done' } })
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

  it('a turn that ends by scheduling its own wakeup stays working (it will self-resume, not await the user) — even with trailing courtesy text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-agent-state-'))
    const transcript = join(dir, 't.jsonl')
    await writeFile(
      transcript,
      [
        '{"type":"user","message":{"role":"user","content":"keep looping"}}',
        assistantLine([
          { type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 600 } },
        ]),
        userLine([{ type: 'tool_result', tool_use_id: 'w1', content: 'Next wakeup scheduled' }]),
        // A /loop tick often prints a one-line recap AFTER scheduling. That trailing
        // "complete" text must NOT flip the verdict back to idle/finished.
        assistantLine([text('Iteration complete; loop armed.')]),
      ].join('\n'),
    )
    const events = await translateClaudeHookPayload({
      hook_event_name: 'Stop',
      transcript_path: transcript,
      permission_mode: 'default',
      stop_hook_active: false,
    })
    expect(events).toEqual([{ kind: 'activity' }])
  })
})

describe('bootEvents', () => {
  it('fresh spawn → session_started (idle, no verdict)', async () => {
    const events = await claudeCodeStateProvider.bootEvents?.({ cwd: '/proj' })
    expect(events).toEqual([{ kind: 'session_started' }])
  })

  it('resume → classifies the tail and stamps the last DATED record time, not the mtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-boot-home-'))
    const cwd = '/home/dev/my.app'
    const projectDir = join(home, '.claude', 'projects', '-home-dev-my-app')
    await mkdir(projectDir, { recursive: true })
    const transcript = join(projectDir, 'conv1.jsonl')
    const realActivity = '2026-06-19T17:45:23.251Z'
    await writeFile(
      transcript,
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: realActivity,
          message: {
            role: 'assistant',
            content: [text('Should I also migrate the staging database?')],
          },
        }),
        // Claude appends timestamp-less metadata (bridge-session etc.) on resume/
        // reattach. These bump the file mtime to "now" but are NOT activity — recency
        // must come from the last DATED record, not the mtime.
        JSON.stringify({ type: 'bridge-session', sessionId: 'conv1', bridgeSessionId: 'cse_x' }),
      ].join('\n'),
    )
    const events = await claudeCodeStateProvider.bootEvents?.({
      cwd,
      resumeValue: 'conv1',
      homeDir: home,
    })
    expect(events).toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'question', summary: 'Should I also migrate the staging database?' },
        at: realActivity,
      },
    ])
  })

  it('resume onto a PENDING AskUserQuestion menu → needs_user/question (same wire shape as the live hook path), stamped with the record time [#63]', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-boot-home-'))
    const cwd = '/home/dev/my.app'
    const projectDir = join(home, '.claude', 'projects', '-home-dev-my-app')
    await mkdir(projectDir, { recursive: true })
    const transcript = join(projectDir, 'conv-ask.jsonl')
    const realActivity = '2026-06-21T09:00:00.000Z'
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'pick one' } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: realActivity,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'ask1',
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'Which database?', header: 'DB' }] },
              },
            ],
          },
        }),
      ].join('\n'),
    )
    const events = await claudeCodeStateProvider.bootEvents?.({
      cwd,
      resumeValue: 'conv-ask',
      homeDir: home,
    })
    // Must match the LIVE PreToolUse translation shape (needs_user/question), not a
    // turn_completed 'question' verdict: idle/question after a restart hid the menu
    // from the superagent answer_question gate and NEEDS-ATTENTION grouping.
    expect(events).toEqual([
      { kind: 'needs_user', need: 'question', summary: 'Which database?', at: realActivity },
    ])
    // Parity through the reducer: the boot seed and the live hook event land on the
    // same phase/need.
    const now = '2026-06-21T10:00:00.000Z'
    const booted = reduceAgentState(initialAgentState(now), (events ?? [])[0]!, now)
    const liveEvents = await translateClaudeHookPayload({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which database?', header: 'DB' }] },
    })
    const live = reduceAgentState(initialAgentState(now), liveEvents[0]!, now)
    expect(booted.phase).toBe('needs_user')
    expect(booted.phase).toBe(live.phase)
    expect('need' in booted && booted.need).toEqual('need' in live && live.need)
  })

  it('resume onto an ANSWERED AskUserQuestion → neither needs_user nor an idle question verdict', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-boot-home-'))
    const cwd = '/home/dev/my.app'
    const projectDir = join(home, '.claude', 'projects', '-home-dev-my-app')
    await mkdir(projectDir, { recursive: true })
    const transcript = join(projectDir, 'conv-answered.jsonl')
    const realActivity = '2026-06-21T09:05:00.000Z'
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'pick one' } }),
        assistantLine([
          {
            type: 'tool_use',
            id: 'ask1',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which database?', header: 'DB' }] },
          },
        ]),
        userLine([{ type: 'tool_result', tool_use_id: 'ask1', content: 'Postgres' }]),
        JSON.stringify({
          type: 'assistant',
          timestamp: realActivity,
          message: { role: 'assistant', content: [text('Done — Postgres it is.')] },
        }),
      ].join('\n'),
    )
    const events = await claudeCodeStateProvider.bootEvents?.({
      cwd,
      resumeValue: 'conv-answered',
      homeDir: home,
    })
    expect(events).toHaveLength(1)
    expect(events?.[0]).toMatchObject({
      kind: 'turn_completed',
      verdict: { kind: 'done' },
      at: realActivity,
    })
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

  it('resume → a transcript that does NOT yield a verdict still stamps the last DATED record time (a reattach must never restamp recency to "now")', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-boot-home-'))
    const cwd = '/home/dev/my.app'
    const projectDir = join(home, '.claude', 'projects', '-home-dev-my-app')
    await mkdir(projectDir, { recursive: true })
    const transcript = join(projectDir, 'conv2.jsonl')
    const realActivity = '2026-06-20T10:11:12.131Z'
    // Autonomous-continuation text classifies as needs_semantic_classification →
    // no verdict; the existing code would fall back to a bare session_started
    // (since=now), restamping this session to the reattach time and jumping it to
    // the top of NEEDS YOUR ATTENTION. It must carry the real last-activity time.
    await writeFile(
      transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: realActivity,
        message: {
          role: 'assistant',
          content: [text("I'll continue and report back when it finishes.")],
        },
      }),
    )
    const events = await claudeCodeStateProvider.bootEvents?.({
      cwd,
      resumeValue: 'conv2',
      homeDir: home,
    })
    expect(events).toEqual([{ kind: 'session_started', at: realActivity }])
  })
})
