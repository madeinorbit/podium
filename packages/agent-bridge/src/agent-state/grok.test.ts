import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  it('does not inject CLI args or project files', () => {
    expect(
      grokStateProvider.instrumentation({
        endpointUrl: 'http://127.0.0.1:1/hooks/s1',
        settingsPath: '/tmp/unused.json',
      }),
    ).toEqual({ args: [] })
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

    await expect(
      grokStateProvider.bootEvents?.({ cwd, resumeValue: 'g1', homeDir: home }),
    ).resolves.toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'question', summary: 'Want me to run the tests?' },
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
      startedAtMs: Date.now(),
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

  it('finds a fresh Grok session, reports the resume id, and emits update events', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-grok-observe-'))
    const cwd = '/repo/grok'
    const seenSessions: string[] = []
    const events: unknown[] = []
    const observer = observeGrokState({
      homeDir: home,
      cwd,
      pollMs: 10,
      startedAtMs: Date.now(),
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
