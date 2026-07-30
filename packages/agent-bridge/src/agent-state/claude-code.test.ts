import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentStateProviderFor } from '../harness/registry.js'
import { acceptAgentObservation } from './causal'
import {
  ClaudeCausalObserver,
  captureClaudeTranscript,
  classifyClaudeTranscriptState,
  classifyIdleTranscript,
  claudeCodeStateProvider,
  claudePromptHookFingerprint,
  claudeTranscriptSegmentId,
  parseClaudeTranscriptSegmentId,
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
describe('ClaudeCausalObserver [spec:SP-cdb2]', () => {
  const at = '2026-07-18T12:00:00.000Z'
  const idle = { phase: 'idle' as const, since: at, workingMsTotal: 0, nativeSubagentCount: 0 }
  const observer = (state: Parameters<typeof reduceAgentState>[0] = idle, generation = 7) =>
    new ClaudeCausalObserver({
      podiumSessionId: 'podium-1',
      observerGeneration: generation,
      bindingVersion: 3,
      providerSessionId: 'claude-1',
      transcriptPath: '/exact/claude-1.jsonl',
      bootstrapState: state,
      bootstrapOffset: 100,
      now: () => at,
    })
  const hook = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name,
    session_id: 'claude-1',
    transcript_path: '/exact/claude-1.jsonl',
    ...extra,
  })

  it('emits exactly one bootstrap snapshot with the exact binding and no live edge', () => {
    const causal = observer()
    expect(causal.bootstrap()).toMatchObject({
      podiumSessionId: 'podium-1',
      provider: 'claude-code',
      providerSessionId: 'claude-1',
      bindingVersion: 3,
      observerGeneration: 7,
      provenance: 'bootstrap',
      transitionKind: 'snapshot',
      priorPhase: 'unknown',
      nextPhase: 'idle',
      turnEpoch: 0,
      inputOrigin: 'provider',
      providerCursor: {
        segmentId: 'claude:claude-1:/exact/claude-1.jsonl',
        components: { transcript: 100 },
      },
    })
    expect(causal.bootstrap()).toBeNull()
  })

  it('folds frozen history and reconnect into snapshots, then emits one real working+terminal turn', async () => {
    const first = observer()
    expect(first.bootstrap()?.provenance).toBe('bootstrap')
    expect(await first.observeHook(hook('Stop', { prompt_id: 'old' }), 100)).toBeNull()
    const restarted = observer(idle, 8)
    expect(restarted.bootstrap()).toMatchObject({
      observerGeneration: 8,
      provenance: 'bootstrap',
      transitionKind: 'snapshot',
    })
    expect(await restarted.observeHook(hook('SessionStart'), 100)).toBeNull()
    restarted.recordInputOrigin('human')
    expect(
      await restarted.observeHook(hook('UserPromptSubmit', { prompt_id: 'prompt-1' }), 120),
    ).toMatchObject({
      transitionKind: 'turn_opened',
      inputOrigin: 'human',
      turnEpoch: 1,
      priorPhase: 'idle',
      nextPhase: 'working',
      providerPromptId: 'prompt-1',
    })
    expect(await restarted.observeHook(hook('Stop', { prompt_id: 'prompt-1' }), 180)).toMatchObject(
      {
        transitionKind: 'turn_terminal',
        inputOrigin: 'human',
        turnEpoch: 1,
        priorPhase: 'working',
        nextPhase: 'idle',
        state: { idle: { kind: 'done' } },
      },
    )
  })

  it('bounds pending input origins and seen hook identities', async () => {
    const causal = observer()
    causal.bootstrap()
    for (let index = 0; index < 100; index += 1) causal.recordInputOrigin('human')
    expect(causal.pendingInputOriginCount).toBe(64)

    for (let index = 0; index < 400; index += 1) {
      await causal.observeHook(
        hook('PreToolUse', { prompt_id: 'p1', tool_use_id: `tool-${index}` }),
        100 + index,
      )
    }
    expect(causal.seenRecordCount).toBe(256)
  })

  it('makes terminal absorbing: duplicate stop and late same-epoch hooks emit nothing', async () => {
    const causal = observer()
    causal.bootstrap()
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p1' }), 110, 'controller')
    expect(await causal.observeHook(hook('Stop', { prompt_id: 'p1' }), 120)).not.toBeNull()
    expect(await causal.observeHook(hook('Stop', { prompt_id: 'p1' }), 120)).toBeNull()
    expect(
      await causal.observeHook(
        hook('PreToolUse', { prompt_id: 'p1', tool_use_id: 'late-tool' }),
        130,
      ),
    ).toBeNull()
    expect(
      await causal.observeHook(hook('SubagentStart', { prompt_id: 'p1', agent_id: 'late' }), 140),
    ).toBeNull()
  })

  it('allows only matching child bookkeeping to close a terminal epoch', async () => {
    const causal = observer()
    causal.bootstrap()
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p1' }), 110)
    await causal.observeHook(hook('SubagentStart', { prompt_id: 'p1', agent_id: 'child-1' }), 120)
    expect(await causal.observeHook(hook('Stop', { prompt_id: 'p1' }), 130)).toMatchObject({
      transitionKind: 'turn_terminal',
      nextPhase: 'working',
      state: { awaitingSubagents: true, nativeSubagentCount: 1 },
    })
    expect(
      await causal.observeHook(hook('SubagentStop', { prompt_id: 'p1', agent_id: 'other' }), 140),
    ).toBeNull()
    expect(
      await causal.observeHook(hook('SubagentStop', { prompt_id: 'p1', agent_id: 'child-1' }), 150),
    ).toMatchObject({
      transitionKind: 'subagent_bookkeeping',
      priorPhase: 'working',
      nextPhase: 'idle',
      state: { nativeSubagentCount: 0, idle: { kind: 'done' } },
    })
  })

  it('opens epochs only on exact-session provider-confirmed prompts and preserves input origins', async () => {
    const causal = observer({ ...idle, idle: { kind: 'done' as const } })
    causal.bootstrap()
    causal.recordInputOrigin('mail')
    expect(await causal.observeHook(hook('PostToolUse', { tool_use_id: 'noise' }), 110)).toBeNull()
    expect(
      await causal.observeHook(
        { ...hook('UserPromptSubmit', { prompt_id: 'wrong' }), session_id: 'other' },
        120,
      ),
    ).toBeNull()
    expect(
      await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'mail-prompt' }), 130),
    ).toMatchObject({ inputOrigin: 'mail', turnEpoch: 1 })
    const system = observer()
    system.bootstrap()
    expect(
      await system.observeHook(
        hook('UserPromptSubmit', { prompt_id: 'system-prompt', promptSource: 'system' }),
        110,
      ),
    ).toMatchObject({ inputOrigin: 'system' })
  })

  it('anchors no-ID prompts to physical records plus canonical payloads', async () => {
    const causal = observer()
    causal.bootstrap()
    const firstPayload = hook('UserPromptSubmit', { prompt: 'first real prompt' })
    const firstFingerprint = claudePromptHookFingerprint(firstPayload)
    if (!firstFingerprint) throw new Error('expected prompt fingerprint')
    const firstIdentity = { recordBoundary: 120, payloadFingerprint: firstFingerprint }
    expect(
      await causal.observeHook(firstPayload, 120, undefined, undefined, firstIdentity),
    ).toMatchObject({ transitionKind: 'turn_opened', turnEpoch: 1 })
    expect(
      await causal.observeHook(firstPayload, 120, undefined, undefined, firstIdentity),
    ).toBeNull()
    expect(await causal.observeHook(hook('Stop'), 130)).toMatchObject({
      transitionKind: 'turn_terminal',
      turnEpoch: 1,
    })

    const secondPayload = hook('UserPromptSubmit', { prompt: 'second real prompt' })
    const secondFingerprint = claudePromptHookFingerprint(secondPayload)
    if (!secondFingerprint) throw new Error('expected prompt fingerprint')
    expect(
      await causal.observeHook(secondPayload, 170, undefined, undefined, {
        recordBoundary: 170,
        payloadFingerprint: secondFingerprint,
      }),
    ).toMatchObject({ transitionKind: 'turn_opened', turnEpoch: 2 })
  })

  it('opens an unflushed reminder prompt from the live hook identity', async () => {
    const causal = observer()
    causal.bootstrap()
    const payload = hook('UserPromptSubmit', {
      promptSource: 'system',
      prompt: '<system-reminder>You have new Podium mail.</system-reminder>',
    })
    const fingerprint = claudePromptHookFingerprint(payload)
    if (!fingerprint) throw new Error('expected reminder fingerprint')

    expect(await causal.observeHook(payload, 100)).toMatchObject({
      transitionKind: 'turn_opened',
      turnEpoch: 1,
      inputOrigin: 'system',
      providerPromptId: 'fingerprint:' + fingerprint,
      providerCursor: { components: { transcript: 100, hook: 1 } },
    })
    expect(await causal.observeHook(payload, 100)).toBeNull()
    expect(await causal.observeHook(hook('Stop'), 100)).toMatchObject({
      transitionKind: 'turn_terminal',
      turnEpoch: 1,
      providerCursor: { components: { transcript: 100, hook: 2 } },
    })
  })

  it('rejects mismatched prompt IDs without poisoning the valid hook identity', async () => {
    const causal = observer()
    causal.bootstrap()
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'current' }), 110)
    const tool = {
      prompt_id: 'wrong',
      tool_use_id: 'tool-1',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Proceed?' }] },
    }
    expect(await causal.observeHook(hook('PreToolUse', tool), 120)).toBeNull()
    expect(
      await causal.observeHook(hook('PreToolUse', { ...tool, prompt_id: 'current' }), 120),
    ).toMatchObject({
      sourceEventKind: 'PreToolUse',
      transitionKind: 'activity',
      nextPhase: 'needs_user',
    })
    expect(await causal.observeHook(hook('Stop', { prompt_id: 'wrong' }), 130)).toBeNull()
    expect(await causal.observeHook(hook('Stop', { prompt_id: 'current' }), 130)).toMatchObject({
      transitionKind: 'turn_terminal',
    })
  })

  it('settles scheduled self-wake and attributes its next confirmed prompt to auto_continue', async () => {
    const causal = observer()
    causal.bootstrap()
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'loop-1' }), 110, 'human')
    expect(
      await causal.observeHook(
        hook('Stop', { prompt_id: 'loop-1', scheduled_self_wake: true }),
        120,
      ),
    ).toMatchObject({ transitionKind: 'turn_terminal', nextPhase: 'idle' })
    expect(
      await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'loop-2' }), 130),
    ).toMatchObject({ transitionKind: 'turn_opened', turnEpoch: 2, inputOrigin: 'auto_continue' })
  })
  it('links a fresh transcript segment to the accepted restart cursor and permits later epochs', async () => {
    const causal = observer()
    causal.bootstrap()
    causal.acknowledgeCursor({
      segmentId: 'claude:claude-1:/previous/transcript.jsonl',
      components: { transcript: 900 },
    })
    const opened = await causal.observeHook(
      hook('UserPromptSubmit', { prompt_id: 'fresh-1' }),
      causal.nextHookOffset(12),
      'steward',
    )
    expect(opened).toMatchObject({
      transitionKind: 'turn_opened',
      providerCursor: {
        segmentId: 'claude:claude-1:/exact/claude-1.jsonl',
        predecessorSegmentId: 'claude:claude-1:/previous/transcript.jsonl',
      },
    })
    await causal.observeHook(hook('Stop', { prompt_id: 'fresh-1' }), 14)
    expect(
      await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'fresh-2' }), 15),
    ).toMatchObject({ turnEpoch: 2, transitionKind: 'turn_opened' })
    expect(await causal.observeHook(hook('Stop'), 16)).toMatchObject({
      turnEpoch: 2,
      transitionKind: 'turn_terminal',
    })
  })

  it('links a same-file truncation as a successor segment', async () => {
    const causal = observer()
    causal.bootstrap()
    const baseSegment = claudeTranscriptSegmentId('claude-1', {
      path: '/exact/claude-1.jsonl',
      device: '7',
      inode: '11',
    })
    await causal.observeHook(
      hook('UserPromptSubmit', { prompt_id: 'before-truncate' }),
      120,
      undefined,
      baseSegment,
    )
    const terminal = await causal.observeHook(
      hook('Stop', { prompt_id: 'before-truncate' }),
      10,
      undefined,
      baseSegment,
    )
    expect(terminal?.providerCursor).toMatchObject({
      predecessorSegmentId: baseSegment,
      components: { transcript: 10, hook: 2 },
    })
    expect(terminal?.providerCursor.segmentId.startsWith(`${baseSegment}:after:`)).toBe(true)
  })

  it('keeps same-EOF hooks strictly ordered across restart without advancing the byte boundary', async () => {
    const lease = {
      provider: 'claude-code' as const,
      providerSessionId: 'claude-1',
      bindingVersion: 3,
      observationGeneration: 7,
    }
    const causal = observer()
    const bootstrap = causal.bootstrap()
    if (!bootstrap) throw new Error('expected bootstrap observation')
    const bootResult = acceptAgentObservation(null, lease, bootstrap, at)
    if (bootResult.kind === 'rejected') throw new Error(bootResult.rejectionReason)
    const opened = await causal.observeHook(
      hook('UserPromptSubmit', { prompt_id: 'same-eof' }),
      100,
    )
    expect(opened?.providerCursor.components).toEqual({ transcript: 100, hook: 1 })
    if (!opened) throw new Error('expected opening observation')
    const openResult = acceptAgentObservation(bootResult.checkpoint, lease, opened, at)
    if (openResult.kind === 'rejected') throw new Error(openResult.rejectionReason)
    const terminal = await causal.observeHook(hook('Stop', { prompt_id: 'same-eof' }), 100)
    if (!terminal) throw new Error('expected terminal observation')
    expect(terminal?.providerCursor.components).toEqual({ transcript: 100, hook: 2 })
    const terminalResult = acceptAgentObservation(openResult.checkpoint, lease, terminal, at)
    if (terminalResult.kind === 'rejected') throw new Error(terminalResult.rejectionReason)

    const restarted = new ClaudeCausalObserver({
      podiumSessionId: 'podium-1',
      observerGeneration: 8,
      bindingVersion: 3,
      providerSessionId: 'claude-1',
      transcriptPath: '/exact/claude-1.jsonl',
      bootstrapState: terminal.state,
      bootstrapOffset: 100,
      acceptedCheckpoint: terminalResult.checkpoint,
      now: () => at,
    })
    expect(restarted.bootstrap()?.providerCursor.components).toEqual({ transcript: 100, hook: 2 })
    expect(
      await restarted.observeHook(hook('UserPromptSubmit', { prompt_id: 'after-restart' }), 120),
    ).toMatchObject({
      turnEpoch: 2,
      providerCursor: { components: { transcript: 120, hook: 3 } },
    })
  })

  it('captures only complete JSONL boundaries and recognizes a prompt when a torn record completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-capture-'))
    const path = join(dir, 'claude.jsonl')
    const prompt = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'continue' },
    })}\n`
    const torn = '{"type":"assistant"'
    await writeFile(path, `${prompt}${torn}`)
    const first = await captureClaudeTranscript(path)
    expect(first.boundary).toBe(Buffer.byteLength(prompt))
    expect(first.prompts).toEqual([
      expect.objectContaining({ offset: 0, origin: 'unknown', hasAssistantOutputAfter: false }),
    ])

    const completion =
      ',"message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'
    await appendFile(path, completion)
    const second = await captureClaudeTranscript(path)
    expect(second.boundary).toBe(Buffer.byteLength(`${prompt}${torn}${completion}`))
    expect(second.prompts).toEqual([
      expect.objectContaining({ offset: 0, origin: 'unknown', hasAssistantOutputAfter: true }),
    ])
    expect(second.fileIdentity).toBe(first.fileIdentity)
    expect(parseClaudeTranscriptSegmentId(claudeTranscriptSegmentId('claude-1', second))).toEqual({
      path,
      device: second.device,
      inode: second.inode,
    })
    expect(second).toMatchObject({ path, device: expect.any(String), inode: expect.any(String) })
  })

  it('captures metadata and pure system reminders as causal prompt evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-reminder-evidence-'))
    const path = join(dir, 'claude.jsonl')
    const reminder = '<system-reminder>You have new Podium mail.</system-reminder>'
    const record = JSON.stringify({
      type: 'user',
      isMeta: true,
      promptSource: 'system',
      message: { role: 'user', content: reminder },
    })
    try {
      await writeFile(path, record + '\n')
      const capture = await captureClaudeTranscript(path)
      const hookFingerprint = claudePromptHookFingerprint({ prompt: reminder })
      expect(capture).toMatchObject({
        promptCount: 1,
        firstPrompt: { origin: 'system', payloadFingerprint: hookFingerprint },
        latestPrompt: { origin: 'system', payloadFingerprint: hookFingerprint },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('classifies a bounded tail while incrementally scanning only the accepted large-prefix gap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-large-gap-'))
    const path = join(dir, 'claude.jsonl')
    const prefix = `${'x'.repeat(2 * 1024 * 1024)}\n`
    const promptRecord = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'gap prompt' },
    })
    await writeFile(path, `${prefix}${promptRecord}`)
    const capture = await captureClaudeTranscript(path, {
      promptScanStart: Buffer.byteLength(prefix),
    })
    expect(capture.boundary).toBe(Buffer.byteLength(`${prefix}${promptRecord}`))
    expect(capture.promptCount).toBe(1)
    expect(capture.prompts).toEqual([])
    expect(capture.latestPrompt).toMatchObject({
      offset: Buffer.byteLength(prefix),
      recordBoundary: capture.boundary,
      hasAssistantOutputAfter: false,
    })

    await appendFile(path, '\n{"type":"assistant"')
    const torn = await captureClaudeTranscript(path, {
      promptScanStart: capture.boundary,
      promptScanIdentity: capture,
    })
    expect(torn.boundary).toBe(capture.boundary + 1)
    expect(torn.prompts).toEqual([])
    expect(torn.promptCount).toBe(0)
  })

  it('detects same-path replacement and scans the successor from byte zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-replacement-'))
    const path = join(dir, 'claude.jsonl')
    const replacement = join(dir, 'replacement.jsonl')
    await writeFile(path, `${JSON.stringify({ type: 'bridge-session' })}\n`)
    const accepted = await captureClaudeTranscript(path)
    const prompt = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'replacement prompt' },
    })
    await writeFile(replacement, prompt)
    await rename(replacement, path)

    const captured = await captureClaudeTranscript(path, {
      promptScanStart: accepted.boundary,
      promptScanIdentity: accepted,
    })
    expect(captured.fileIdentity).not.toBe(accepted.fileIdentity)
    expect(captured.promptCount).toBe(1)
    expect(captured.latestPrompt).toMatchObject({ offset: 0, recordBoundary: captured.boundary })
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
