import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyGrokIdleTranscript,
  grokSessionPaths,
  grokStateProvider,
  observeGrokState,
  translateGrokUpdatePayload,
} from './grok'

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

describe('observeGrokState', () => {
  it('infers turn completion when Grok returns to available commands without a stop hook', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-observe-'))
    const cwd = '/repo/grok'
    const events: unknown[] = []
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      pollMs: 10,
      onEvents: (next) => events.push(...next),
    })
    try {
      const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-hookless' })
      await mkdir(paths.sessionDir, { recursive: true })
      await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-hookless', cwd } }))
      await writeFile(
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
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      pollMs: 10,
      onSession: (sessionId) => seenSessions.push(sessionId),
      onEvents: (next) => events.push(...next),
    })
    try {
      const paths = grokSessionPaths({ homeDir: home, cwd, sessionId: 'g-new' })
      await mkdir(paths.sessionDir, { recursive: true })
      await writeFile(paths.summaryPath, JSON.stringify({ info: { id: 'g-new', cwd } }))
      await writeFile(
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

async function waitFor(fn: () => boolean): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 1000) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
