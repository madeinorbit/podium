import { appendFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentObservation,
  AgentObservationAckMessage,
  SessionObservationCheckpointV1,
} from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { acceptAgentObservation } from './causal'
import { GrokCausalObserver } from './grok-causal'
import { grokAdapter } from '../harness/adapters/grok'
import type { HarnessObserverHost } from '../harness/adapter'
import {
  classifyGrokIdleTranscript,
  grokSessionPaths,
  grokStateProvider,
  normalizeGrokProviderTimestamp,
  observeGrokState,
  translateGrokUpdatePayload,
} from './grok'
import { initialAgentState, reduceAgentState } from './reducer'
import type { AgentStateEvent } from './types'

const text = (value: string) => ({ type: 'text', text: value })

describe('grok live state provider', () => {
  it('injects only the per-session callback for the global hook install', () => {
    expect(
      grokStateProvider.instrumentation({
        endpointUrl: 'http://127.0.0.1:1/hooks/s1',
        settingsPath: '/tmp/unused.json',
      }),
    ).toEqual({
      args: [],
      env: { PODIUM_GROK_HOOK_URL: 'http://127.0.0.1:1/hooks/s1' },
    })
  })

  it('maps Grok update records to normalized state events', async () => {
    const event = (sessionUpdate: string, extra: Record<string, unknown> = {}) =>
      translateGrokUpdatePayload({
        method: 'session/update',
        params: { update: { sessionUpdate, ...extra } },
      })

    await expect(event('user_message_chunk')).resolves.toEqual([{ kind: 'prompt_submitted' }])
    await expect(event('agent_thought_chunk')).resolves.toEqual([{ kind: 'activity' }])
    await expect(event('agent_message_chunk')).resolves.toEqual([{ kind: 'activity' }])
    await expect(event('retry_state', { type: 'retrying', attempt: 1 })).resolves.toEqual([
      { kind: 'activity' },
    ])
    await expect(event('hook_execution', { event_name: 'user_prompt_submit' })).resolves.toEqual([
      { kind: 'prompt_submitted' },
    ])
    await expect(event('hook_execution', { event_name: 'pre_compact' })).resolves.toEqual([
      { kind: 'compaction', phase: 'start' },
    ])
    await expect(event('hook_execution', { event_name: 'post_compact' })).resolves.toEqual([
      { kind: 'compaction', phase: 'end' },
    ])
    await expect(event('hook_execution', { event_name: 'session_end' })).resolves.toEqual([
      { kind: 'session_ended' },
    ])
  })

  it('classifies Grok structured provider failures', async () => {
    const usageLimit = `API error (status 402 Payment Required): Grok Build usage balance exhausted

Request URL: https://cli-chat-proxy.grok.com/v1/responses`

    await expect(
      translateGrokUpdatePayload({
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'retry_state',
            type: 'failed',
            error_type: 'api',
            message: usageLimit,
          },
        },
      }),
    ).resolves.toEqual([{ kind: 'turn_failed', errorClass: 'usage_limit', retryable: false }])

    await expect(
      translateGrokUpdatePayload({
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'retry_state',
            type: 'exhausted',
            reason: 'API error (status 429 Too Many Requests): service at capacity',
            is_rate_limited: true,
          },
        },
      }),
    ).resolves.toEqual([{ kind: 'turn_failed', errorClass: 'rate_limit', retryable: true }])

    await expect(
      translateGrokUpdatePayload({
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'turn_completed',
            stop_reason: 'error',
            agent_result: usageLimit,
          },
        },
      }),
    ).resolves.toEqual([{ kind: 'turn_failed', errorClass: 'usage_limit', retryable: false }])
  })

  it('maps native camelCase Grok hooks and classifies Stop from chat history', async () => {
    await expect(
      translateGrokUpdatePayload({ hookEventName: 'SessionStart', sessionId: 'g-native' }),
    ).resolves.toEqual([{ kind: 'session_started' }])
    await expect(
      translateGrokUpdatePayload({
        hookEventName: 'PreToolUse',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: 'Which implementation?' }] },
      }),
    ).resolves.toEqual([{ kind: 'needs_user', need: 'question', summary: 'Which implementation?' }])
    await expect(
      translateGrokUpdatePayload({ hookEventName: 'PermissionDenied', toolName: 'Bash' }),
    ).resolves.toEqual([{ kind: 'needs_user', need: 'permission', summary: 'Bash' }])
    await expect(
      translateGrokUpdatePayload({ hookEventName: 'StopFailure', errorType: 'rate_limit' }),
    ).resolves.toEqual([{ kind: 'turn_failed', errorClass: 'rate_limit', retryable: true }])

    const home = await mkdtemp(join(tmpdir(), 'podium-grok-hook-'))
    const paths = grokSessionPaths({ homeDir: home, cwd: '/repo/grok', sessionId: 'g-native' })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.chatHistoryPath, JSON.stringify({ type: 'assistant', content: 'Done.' }))
    await expect(
      translateGrokUpdatePayload({
        hookEventName: 'Stop',
        chatHistoryPath: paths.chatHistoryPath,
      }),
    ).resolves.toEqual([{ kind: 'turn_completed', verdict: { kind: 'done' } }])
  })

  it('stamps the update timestamp as event-time (at) so reattach replays carry the real time', async () => {
    const events = await translateGrokUpdatePayload({
      timestamp: '2026-06-12T14:00:00.000Z',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk' } },
    })
    expect(events[0]?.at).toBe('2026-06-12T14:00:00.000Z')
  })

  it('normalizes ISO and numeric provider timestamps without restamping them', async () => {
    expect(normalizeGrokProviderTimestamp('2026-06-12T16:00:00+02:00')).toBe(
      '2026-06-12T14:00:00.000Z',
    )
    expect(normalizeGrokProviderTimestamp(1_717_680_000)).toBe('2024-06-06T13:20:00.000Z')
    expect(normalizeGrokProviderTimestamp(1_717_680_000_000)).toBe('2024-06-06T13:20:00.000Z')
    expect(normalizeGrokProviderTimestamp(Number.NaN)).toBeUndefined()
    expect(normalizeGrokProviderTimestamp('not-a-date')).toBeUndefined()

    for (const timestamp of [1_717_680_000, 1_717_680_000_000]) {
      const events = await translateGrokUpdatePayload({
        timestamp,
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk' } },
      })
      expect(events[0]?.at).toBe('2024-06-06T13:20:00.000Z')
    }
  })

  it('classifies Grok chat history idle verdicts', () => {
    expect(
      classifyGrokIdleTranscript([
        { type: 'assistant', content: 'All set.' },
        { type: 'assistant', content: [text('Should I also update the docs?')] },
      ]),
    ).toEqual({ kind: 'question', summary: 'Should I also update the docs?' })
    expect(classifyGrokIdleTranscript([{ type: 'assistant', content: 'Done.' }])).toEqual({
      kind: 'done',
    })
  })

  it('bootEvents classifies a resumed Grok chat history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-home-'))
    const cwd = '/repo/grok'
    const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g1' })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(
      paths.chatHistoryPath,
      JSON.stringify({ type: 'assistant', content: 'Want me to run the tests?' }),
    )
    const { mtime } = await stat(paths.chatHistoryPath)

    await expect(
      grokStateProvider.bootEvents?.({ cwd, resumeValue: 'g1', homeDir: home }),
    ).resolves.toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'question', summary: 'Want me to run the tests?' },
        at: mtime.toISOString(),
      },
    ])
  })
})

describe('grok turn completion ([spec:SP-8b0e])', () => {
  const update = (sessionUpdate: string, extra: Record<string, unknown> = {}) => ({
    method: '_x.ai/session/update',
    params: { update: { sessionUpdate, ...extra } },
  })

  const reduceSequence = async (records: unknown[]) => {
    const at = '2026-07-15T00:00:00.000Z'
    let state = initialAgentState(at)
    for (const record of records) {
      for (const event of await translateGrokUpdatePayload(record)) {
        state = reduceAgentState(state, event, at)
      }
    }
    return state
  }

  it('treats the turn_completed sessionUpdate as a turn boundary', async () => {
    await expect(
      translateGrokUpdatePayload(update('turn_completed', { stop_reason: 'end_turn' })),
    ).resolves.toEqual([{ kind: 'turn_completed' }])
  })

  it('a completed Grok turn ends idle even when a trailing message chunk follows the stop hook', async () => {
    // Real Grok emits, at every turn boundary:
    //   hook_execution/stop  →  agent_message_chunk  →  turn_completed(end_turn)
    // The trailing chunk re-flips the phase to 'working'; the authoritative
    // turn_completed must land the session back at 'idle'.
    const state = await reduceSequence([
      update('user_message_chunk'),
      update('agent_message_chunk'),
      update('hook_execution', { event_name: 'stop' }),
      update('agent_message_chunk'),
      update('turn_completed', { stop_reason: 'end_turn' }),
    ])
    expect(state.phase).toBe('idle')
  })

  it('an errored turn boundary overrides the preceding clean Stop hook', async () => {
    const state = await reduceSequence([
      update('user_message_chunk'),
      update('hook_execution', { event_name: 'stop' }),
      update('turn_completed', {
        stop_reason: 'error',
        agent_result: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
      }),
    ])
    expect(state).toMatchObject({
      phase: 'errored',
      error: { class: 'usage_limit', retryable: false },
    })
  })

  it('a backgrounded task completing after the turn does not resurrect working', async () => {
    // task_backgrounded / task_completed are the ACP lifecycle of a detached
    // shell command that runs alongside the turn. Its completion arriving after
    // turn_completed must NOT flip an idle session back to working.
    const state = await reduceSequence([
      update('user_message_chunk'),
      update('turn_completed', { stop_reason: 'end_turn' }),
      update('task_completed', { task_snapshot: { task_id: 't1' } }),
    ])
    expect(state.phase).toBe('idle')
  })
})

describe('observeGrokState', () => {
  it('frozen history and observer restart emit zero live edges', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-frozen-'))
    const cwd = '/repo/grok'
    const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-frozen' })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-frozen', cwd } }))
    await writeFile(
      paths.updatesPath,
      `{"timestamp":1700000000,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","prompt_id":"prompt-old"}}}\n{"timestamp":1700000001000,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","turn_id":"turn-old"}}}\n{"timestamp":1700000002,"method":"session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}}}\n`,
    )

    for (let generation = 0; generation < 2; generation += 1) {
      const events: AgentStateEvent[] = []
      let bootstrapped = false
      const observer = observeGrokState({
        homeDir: home,
        cwd,
        resumeValue: 'g-frozen',
        pollMs: 10,
        onBootstrap: () => {
          bootstrapped = true
        },
        onEvents: (next) => events.push(...next),
      })
      try {
        await waitFor(() => bootstrapped)
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(events).toEqual([])
      } finally {
        observer.stop()
      }
    }
  })

  it('rereads a torn suffix after restart and emits it only when completed live', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-torn-'))
    const cwd = '/repo/grok'
    const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-torn' })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-torn', cwd } }))
    await writeFile(
      paths.updatesPath,
      '{"method":"session/update","params":{"update":{"sessionUpdate":"user_message_',
    )

    const firstEvents: AgentStateEvent[] = []
    let firstBoundary: number | undefined
    const first = observeGrokState({
      homeDir: home,
      cwd,
      resumeValue: 'g-torn',
      pollMs: 10,
      onBootstrap: (boundary) => {
        firstBoundary = boundary
      },
      onEvents: (events) => firstEvents.push(...events),
    })
    try {
      await waitFor(() => firstBoundary !== undefined)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(firstBoundary).toBe(0)
      expect(firstEvents).toEqual([])
    } finally {
      first.stop()
    }

    const restartedEvents: AgentStateEvent[] = []
    let restartedBoundary: number | undefined
    const restarted = observeGrokState({
      homeDir: home,
      cwd,
      resumeValue: 'g-torn',
      pollMs: 10,
      onBootstrap: (boundary) => {
        restartedBoundary = boundary
      },
      onEvents: (events) => restartedEvents.push(...events),
    })
    try {
      await waitFor(() => restartedBoundary !== undefined)
      expect(restartedBoundary).toBe(0)
      await appendFile(paths.updatesPath, 'chunk"}}}\n')
      await waitFor(() => restartedEvents.length === 1)
      expect(restartedEvents).toEqual([{ kind: 'prompt_submitted' }])
    } finally {
      restarted.stop()
    }
  })

  it('accepts a valid final non-newline JSON record into the frozen bootstrap boundary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-final-json-'))
    const cwd = '/repo/grok'
    const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-final-json' })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-final-json', cwd } }))
    const record = JSON.stringify({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk' } },
    })
    await writeFile(paths.updatesPath, record)

    const events: AgentStateEvent[] = []
    let boundary: number | undefined
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      resumeValue: 'g-final-json',
      pollMs: 10,
      onBootstrap: (value) => {
        boundary = value
      },
      onEvents: (next) => events.push(...next),
    })
    try {
      await waitFor(() => boundary !== undefined)
      expect(boundary).toBe(Buffer.byteLength(record))
      expect(events).toEqual([])
    } finally {
      observer.stop()
    }
  })

  it('truncation re-bootstrap is silent and the next real turn has one working and terminal edge', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-truncate-'))
    const cwd = '/repo/grok'
    const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-truncate' })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-truncate', cwd } }))
    await writeFile(paths.updatesPath, '')

    const events: AgentStateEvent[] = []
    let bootstraps = 0
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      resumeValue: 'g-truncate',
      pollMs: 10,
      onBootstrap: () => {
        bootstraps += 1
      },
      onEvents: (next) => events.push(...next),
    })
    try {
      await waitFor(() => bootstraps === 1)
      await appendFile(
        paths.updatesPath,
        `{"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk"}}}\n`,
      )
      await waitFor(() => events.length === 1)

      await writeFile(
        paths.updatesPath,
        `{"timestamp":1600000000,"method":"session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}}}\n`,
      )
      await waitFor(() => bootstraps === 2)
      expect(events).toEqual([{ kind: 'prompt_submitted' }])

      await appendFile(
        paths.updatesPath,
        `{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call"}}}\n{"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk"}}}\n{"method":"session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}}}\n{"method":"session/update","params":{"update":{"sessionUpdate":"tool_result_update"}}}\n{"method":"session/update","params":{"update":{"sessionUpdate":"hook_execution","event_name":"task_created"}}}\n`,
      )
      await waitFor(() => events.length === 3)
      expect(events.map((event) => event.kind)).toEqual([
        'prompt_submitted',
        'prompt_submitted',
        'turn_completed',
      ])
    } finally {
      observer.stop()
    }
  })

  it('infers turn completion when Grok returns to available commands without a stop hook', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-observe-'))
    const cwd = '/repo/grok'
    const events: unknown[] = []
    let bootstrapped = false
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      pollMs: 10,
      onBootstrap: () => {
        bootstrapped = true
      },
      onEvents: (next) => events.push(...next),
    })
    try {
      const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-hookless' })
      await mkdir(paths.sessionDir, { recursive: true })
      await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-hookless', cwd } }))
      await writeFile(paths.updatesPath, '')
      await waitFor(() => bootstrapped)
      await appendFile(
        paths.updatesPath,
        `${[
          JSON.stringify({
            method: 'session/update',
            params: { update: { sessionUpdate: 'user_message_chunk' } },
          }),
          JSON.stringify({
            method: 'session/update',
            params: { update: { sessionUpdate: 'agent_message_chunk' } },
          }),
          JSON.stringify({
            method: 'session/update',
            params: { update: { sessionUpdate: 'available_commands_update' } },
          }),
        ].join('\n')}\n`,
      )

      await waitFor(() => events.length >= 3)
      expect(events).toEqual([
        { kind: 'prompt_submitted' },
        { kind: 'activity' },
        { kind: 'turn_completed' },
      ])
    } finally {
      observer.stop()
    }
  })

  it('settles to idle on the turn_completed sessionUpdate that follows a trailing message chunk', async () => {
    // The exact terminal sequence real Grok writes at a turn boundary. Reduced
    // through the daemon's own path (observer → reducer), the session must end
    // 'idle', not stuck 'working'. [spec:SP-8b0e]
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-turn-'))
    const cwd = '/repo/grok'
    const events: AgentStateEvent[] = []
    let bootstrapped = false
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      pollMs: 10,
      onBootstrap: () => {
        bootstrapped = true
      },
      onEvents: (next) => events.push(...next),
    })
    try {
      const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-turn' })
      await mkdir(paths.sessionDir, { recursive: true })
      await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-turn', cwd } }))
      await writeFile(paths.updatesPath, '')
      await waitFor(() => bootstrapped)
      await appendFile(
        paths.updatesPath,
        `${[
          {
            method: '_x.ai/session/update',
            params: { update: { sessionUpdate: 'user_message_chunk' } },
          },
          {
            method: 'session/update',
            params: { update: { sessionUpdate: 'agent_thought_chunk' } },
          },
          {
            method: '_x.ai/session/update',
            params: { update: { sessionUpdate: 'hook_execution', event_name: 'stop' } },
          },
          {
            method: 'session/update',
            params: { update: { sessionUpdate: 'agent_message_chunk' } },
          },
          {
            method: '_x.ai/session/update',
            params: { update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' } },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n')}\n`,
      )

      await waitFor(() => events.at(-1)?.kind === 'turn_completed')
      let state = initialAgentState('2026-07-15T00:00:00.000Z')
      for (const event of events) state = reduceAgentState(state, event, '2026-07-15T00:00:00.000Z')
      expect(state.phase).toBe('idle')
    } finally {
      observer.stop()
    }
  })

  it('reattach without resumeValue or startedAtMs binds a pre-existing session (watermark=0)', async () => {
    // Regression: on reattach, the daemon passes no startedAtMs to startGrokStateObserver.
    // If startedAtMs defaulted to Date.now(), watermarkMs = now and createdMs < now for
    // any pre-existing session → chooseGrokSessionDir returns undefined → never rebinds.
    // Fix: no startedAtMs → observeGrokState uses watermarkMs=0 (no floor, picks latest-by-mtime).
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-reattach-'))
    const cwd = '/repo/grok'
    const seenSessions: string[] = []
    // No startedAtMs passed — simulates the reattach path where no spawn timestamp is available.
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      pollMs: 10,
      onSession: (sessionId) => seenSessions.push(sessionId),
      onEvents: () => {},
    })
    try {
      const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-preexisting' })
      await mkdir(paths.sessionDir, { recursive: true })
      await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-preexisting', cwd } }))
      await writeFile(paths.updatesPath, '')
      // Even though the session dir was created before the observer started, it must bind.
      await waitFor(() => seenSessions.includes('g-preexisting'))
    } finally {
      observer.stop()
    }
  })

  it('finds a fresh Grok session, reports the resume id, and emits update events', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-observe-'))
    const cwd = '/repo/grok'
    const seenSessions: string[] = []
    const events: unknown[] = []
    let bootstrapped = false
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      pollMs: 10,
      onSession: (sessionId) => seenSessions.push(sessionId),
      onBootstrap: () => {
        bootstrapped = true
      },
      onEvents: (next) => events.push(...next),
    })
    try {
      const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-new' })
      await mkdir(paths.sessionDir, { recursive: true })
      await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-new', cwd } }))
      await writeFile(paths.updatesPath, '')
      await waitFor(() => bootstrapped)
      await appendFile(
        paths.updatesPath,
        `${[
          JSON.stringify({
            method: 'session/update',
            params: { update: { sessionUpdate: 'user_message_chunk' } },
          }),
          JSON.stringify({
            method: 'session/update',
            params: { update: { sessionUpdate: 'hook_execution', event_name: 'stop' } },
          }),
        ].join('\n')}\n`,
      )

      await waitFor(() => seenSessions.includes('g-new') && events.length >= 2)
      expect(events).toEqual([{ kind: 'prompt_submitted' }, { kind: 'turn_completed' }])
    } finally {
      observer.stop()
    }
  })
})

describe('Grok durable causal observations ([spec:SP-cdb2])', () => {
  it('buffers behind ack, preserves numeric provider time, and restarts frozen at zero edges', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-causal-'))
    const cwd = '/repo/grok'
    const sessionId = 'g-causal'
    const paths = grokSessionPaths({ homeDir: home, cwd, sessionId })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.summaryPath, JSON.stringify({ info: { id: sessionId, cwd } }))
    await writeFile(paths.updatesPath, '')

    let checkpoint: SessionObservationCheckpointV1 | null = null
    const observations: AgentObservation[] = []
    let bootstrapped = false
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      resumeValue: sessionId,
      pollMs: 10,
      onBootstrap: () => {
        bootstrapped = true
      },
      causal: {
        podiumSessionId: 'podium-grok',
        providerSessionId: sessionId,
        bindingVersion: 1,
        observerGeneration: 1,
        acceptedCheckpoint: null,
        now: () => '2026-07-19T10:00:00.000Z',
        onObservation: (observation) => observations.push(observation),
      },
    })

    const accept = (observation: AgentObservation): AgentObservationAckMessage => {
      const result = acceptAgentObservation(
        checkpoint,
        {
          provider: 'grok',
          providerSessionId: sessionId,
          bindingVersion: 1,
          observationGeneration: 1,
        },
        observation,
        '2026-07-19T10:00:00.000Z',
      )
      expect(result.kind).not.toBe('rejected')
      if (result.kind === 'rejected') throw new Error(result.rejectionReason)
      checkpoint = result.checkpoint
      return {
        type: 'agentObservationAck',
        sessionId: 'podium-grok',
        observerGeneration: 1,
        bindingVersion: 1,
        transitionId: observation.transitionId,
        result: result.kind,
        acceptedCursor: result.checkpoint.providerCursor,
      }
    }

    try {
      await waitFor(() => bootstrapped && observations.length === 1)
      expect(observations[0]?.provenance).toBe('bootstrap')
      observer.onObservationAck?.(accept(observations[0]!))

      const promptAtSeconds = 1_717_680_000
      await appendFile(
        paths.updatesPath,
        `${[
          {
            timestamp: promptAtSeconds,
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'user_message_chunk',
                prompt_id: 'prompt-native',
              },
            },
          },
          {
            timestamp: 1_717_680_000_500,
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                turn_id: 'turn-native',
              },
            },
          },
          {
            timestamp: 1_717_680_001,
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'turn_completed',
                stop_reason: 'end_turn',
                turn_id: 'turn-native',
              },
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n')}\n`,
      )

      await waitFor(() => observations.length >= 2)
      const opened = observations[1]!
      expect(opened).toMatchObject({
        provenance: 'live',
        transitionKind: 'turn_opened',
        nextPhase: 'working',
        providerPromptId: 'prompt-native',
        providerAt: '2024-06-06T13:20:00.000Z',
      })
      expect(opened.state.since).toBe('2024-06-06T13:20:00.000Z')
      const openedAck = accept(opened)

      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(observations).toHaveLength(2)
      observer.onObservationAck?.(openedAck)

      await waitFor(() => observations.length === 3)
      const terminal = observations[2]!
      expect(terminal).toMatchObject({
        provenance: 'live',
        transitionKind: 'turn_terminal',
        nextPhase: 'idle',
        providerTurnId: 'turn-native',
        providerAt: '2024-06-06T13:20:01.000Z',
      })
      observer.onObservationAck?.(accept(terminal))
      expect(observations.filter((value) => value.provenance === 'live')).toHaveLength(2)
    } finally {
      observer.stop()
    }

    if (!checkpoint) throw new Error('missing accepted checkpoint')
    const restarted: AgentObservation[] = []
    let restartedBootstrap = false
    const restart = observeGrokState({
      homeDir: home,
      cwd,
      resumeValue: sessionId,
      pollMs: 10,
      onBootstrap: () => {
        restartedBootstrap = true
      },
      causal: {
        podiumSessionId: 'podium-grok',
        providerSessionId: sessionId,
        bindingVersion: 1,
        observerGeneration: 2,
        acceptedCheckpoint: checkpoint,
        now: () => '2026-07-19T11:00:00.000Z',
        onObservation: (observation) => restarted.push(observation),
      },
    })
    try {
      await waitFor(() => restartedBootstrap)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(restarted).toEqual([])
    } finally {
      restart.stop()
    }
  })

  it('mints an accepted successor cursor for same-inode truncation', () => {
    let checkpoint: SessionObservationCheckpointV1 | null = null
    const observations: AgentObservation[] = []
    const causal = new GrokCausalObserver({
      podiumSessionId: 'podium-truncate',
      providerSessionId: 'g-truncate-causal',
      bindingVersion: 1,
      observerGeneration: 1,
      acceptedCheckpoint: null,
      now: () => '2026-07-19T12:00:00.000Z',
      onObservation: (observation) => observations.push(observation),
    })
    const lease = {
      provider: 'grok' as const,
      providerSessionId: 'g-truncate-causal',
      bindingVersion: 1,
      observationGeneration: 1,
    }
    const acknowledgeLatest = (): void => {
      const observation = observations.at(-1)
      if (!observation) throw new Error('missing observation')
      const result = acceptAgentObservation(
        checkpoint,
        lease,
        observation,
        '2026-07-19T12:00:00.000Z',
      )
      expect(result.kind).not.toBe('rejected')
      if (result.kind === 'rejected') throw new Error(result.rejectionReason)
      checkpoint = result.checkpoint
      causal.acknowledge({
        type: 'agentObservationAck',
        sessionId: 'podium-truncate',
        observerGeneration: 1,
        bindingVersion: 1,
        transitionId: observation.transitionId,
        result: result.kind,
        acceptedCursor: result.checkpoint.providerCursor,
      })
    }

    const original = {
      segmentId: 'grok:g-truncate-causal:1:2:/tmp/updates.jsonl',
      pathHint: '/tmp/updates.jsonl',
      device: '1',
      inode: '2',
    }
    expect(causal.beginSegment(original, 0)).toBe(0)
    causal.finishBootstrap(causal.cursorFor(original, 0))
    acknowledgeLatest()
    causal.enqueue({
      record: {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'user_message_chunk',
            prompt_id: 'prompt-before-truncate',
          },
        },
      },
      cursor: causal.cursorFor(original, 10),
      events: [{ kind: 'prompt_submitted' }],
      sourceEventKind: 'update:user_message_chunk',
      providerAt: null,
    })
    acknowledgeLatest()
    causal.enqueue({
      record: {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'turn_completed',
            turn_id: 'turn-before-truncate',
          },
        },
      },
      cursor: causal.cursorFor(original, 20),
      events: [{ kind: 'turn_completed' }],
      sourceEventKind: 'update:turn_completed',
      providerAt: null,
    })
    acknowledgeLatest()

    const acceptedBefore = (checkpoint as SessionObservationCheckpointV1 | null)?.providerCursor
    if (!acceptedBefore) throw new Error('missing pre-truncation cursor')
    expect(causal.beginSegment({ ...original }, 20)).toBe(20)
    const successor = { ...original }
    expect(causal.beginSegment(successor, 5, true)).toBe(0)
    expect(successor.segmentId).not.toBe(acceptedBefore.segmentId)
    const successorCursor = causal.cursorFor(successor, 5)
    expect(successorCursor.predecessorSegmentId).toBe(acceptedBefore.segmentId)
    causal.finishBootstrap(successorCursor)

    const replacement = observations.at(-1)
    if (!replacement) throw new Error('missing replacement snapshot')
    expect(replacement).toMatchObject({
      provenance: 'bootstrap',
      transitionKind: 'snapshot',
      turnEpoch: 1,
      nextPhase: 'idle',
    })
    const accepted = acceptAgentObservation(
      checkpoint,
      lease,
      replacement,
      '2026-07-19T12:00:00.000Z',
    )
    expect(accepted.kind).toBe('snapshot_applied')
  })

  it('routes the adapter lease and durable ack without legacy state effects', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-adapter-'))
    const cwd = '/repo/grok'
    const sessionId = 'g-adapter'
    const paths = grokSessionPaths({ homeDir: home, cwd, sessionId })
    await mkdir(paths.sessionDir, { recursive: true })
    await writeFile(paths.summaryPath, JSON.stringify({ info: { id: sessionId, cwd } }))
    await writeFile(paths.updatesPath, '')

    const observations: AgentObservation[] = []
    const onStateEvents = vi.fn()
    const host: HarnessObserverHost = {
      tailFile: vi.fn(),
      onResumeValue: vi.fn(),
      onTitle: vi.fn(),
      onStateEvents,
      onObservation: (observation) => observations.push(observation),
      onExactProviderRebind: vi.fn(),
      onTranscriptItems: vi.fn(),
    }
    const observer = grokAdapter.observer?.(
      {
        cwd,
        homeDir: home,
        resumeValue: sessionId,
        podiumSessionId: 'podium-adapter',
        observationLease: {
          provider: 'grok',
          providerSessionId: sessionId,
          bindingVersion: 3,
          observerGeneration: 4,
          acceptedCheckpoint: null,
        },
      },
      host,
    )
    if (!observer) throw new Error('missing Grok adapter observer')

    try {
      await waitFor(() => observations.length === 1)
      const bootstrap = observations[0]!
      const lease = {
        provider: 'grok' as const,
        providerSessionId: sessionId,
        bindingVersion: 3,
        observationGeneration: 4,
      }
      const accepted = acceptAgentObservation(null, lease, bootstrap, '2026-07-19T13:00:00.000Z')
      expect(accepted.kind).toBe('snapshot_applied')
      if (accepted.kind === 'rejected') throw new Error(accepted.rejectionReason)
      observer.onObservationAck?.({
        type: 'agentObservationAck',
        sessionId: 'podium-adapter',
        observerGeneration: 4,
        bindingVersion: 3,
        transitionId: bootstrap.transitionId,
        result: accepted.kind,
        acceptedCursor: accepted.checkpoint.providerCursor,
      })

      await appendFile(
        paths.updatesPath,
        `${JSON.stringify({
          timestamp: 1_717_680_000,
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'user_message_chunk',
              prompt_id: 'adapter-prompt',
            },
          },
        })}\n`,
      )
      await waitFor(() => observations.length === 2)
      expect(observations[1]).toMatchObject({
        provider: 'grok',
        providerSessionId: sessionId,
        bindingVersion: 3,
        observerGeneration: 4,
        providerPromptId: 'adapter-prompt',
        transitionKind: 'turn_opened',
      })
      expect(onStateEvents).not.toHaveBeenCalled()
    } finally {
      observer.stop()
    }
  })
})

async function waitFor(fn: () => boolean): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 1000) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
