import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { piSessionDir } from '../pi/paths.js'
import {
  classifyPiIdleTranscript,
  observePiState,
  piStateProvider,
  translatePiRecord,
} from './pi.js'
import type { AgentStateEvent } from './types.js'

const at = '2026-09-02T09:48:47.822Z'
const entry = (message: Record<string, unknown>) => ({
  type: 'message',
  id: 'ab00975c',
  parentId: null,
  timestamp: at,
  message,
})
const assistant = (stopReason: string, text = 'done.', extra: Record<string, unknown> = {}) =>
  entry({
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    stopReason,
    ...extra,
  })

describe('translatePiRecord', () => {
  it('maps the session header and user/tool entries', () => {
    expect(translatePiRecord({ type: 'session', id: 'x', timestamp: at })).toEqual([
      { kind: 'session_started', at },
    ])
    expect(translatePiRecord(entry({ role: 'user', content: 'hi' }))).toEqual([
      { kind: 'prompt_submitted', at },
    ])
    expect(translatePiRecord(entry({ role: 'toolResult', toolCallId: 'c', content: [] }))).toEqual([
      { kind: 'activity', at },
    ])
    expect(translatePiRecord({ type: 'model_change', modelId: 'm' })).toEqual([])
    expect(translatePiRecord('nope')).toEqual([])
  })

  it("reads the turn boundary off the assistant entry's stopReason", () => {
    expect(translatePiRecord(assistant('toolUse'))).toEqual([{ kind: 'activity', at }])
    expect(translatePiRecord(assistant('stop'))).toEqual([
      { kind: 'turn_completed', verdict: { kind: 'done' }, at },
    ])
    expect(translatePiRecord(assistant('stop', 'Should I continue with the rename?'))).toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'question', summary: 'Should I continue with the rename?' },
        at,
      },
    ])
    expect(translatePiRecord(assistant('aborted', ''))).toEqual([
      { kind: 'turn_completed', verdict: { kind: 'interrupted' }, at },
    ])
    expect(
      translatePiRecord(assistant('error', '', { errorMessage: '500: simulated provider outage' })),
    ).toEqual([
      { kind: 'turn_failed', errorClass: '500: simulated provider outage', retryable: true, at },
    ])
  })

  it('classifies an idle transcript from its last assistant entry', () => {
    expect(
      classifyPiIdleTranscript([
        entry({ role: 'user', content: 'x' }),
        assistant('stop', 'All set.'),
        entry({ role: 'user', content: 'y' }),
      ]),
    ).toEqual({ kind: 'done', at })
    expect(classifyPiIdleTranscript([assistant('toolUse')])).toBeUndefined()
    expect(classifyPiIdleTranscript([])).toBeUndefined()
  })

  it('stamps poll-channel provenance at the provider boundary', async () => {
    const events = await piStateProvider.translate(assistant('stop'))
    expect(events).toEqual([
      expect.objectContaining({ kind: 'turn_completed', source: 'poll', confidence: 0.7 }),
    ])
  })
})

describe('observePiState', () => {
  it('waits for a known session file to appear, announces it, then tails it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-pi-state-'))
    const cwd = '/work/pi'
    const id = '9e804279-978a-4644-adc4-f815f25a5728'
    const bucket = piSessionDir(cwd, home)
    await mkdir(bucket, { recursive: true })
    const file = join(bucket, `2026-09-02T09-48-46-898Z_${id}.jsonl`)

    const sessions: string[] = []
    const events: AgentStateEvent[] = []
    const obs = observePiState({
      cwd,
      resumeValue: id,
      homeDir: home,
      pollMs: 15,
      onSession: (sessionId, path) => sessions.push(`${sessionId}@${path}`),
      onEvents: (batch) => events.push(...batch),
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(sessions).toEqual([])

      await writeFile(
        file,
        [
          JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd }),
          JSON.stringify(entry({ role: 'user', content: 'first' })),
          JSON.stringify(assistant('stop', 'ok')),
        ].join('\n') + '\n',
      )
      await waitFor(() => events.some((event) => event.kind === 'turn_completed'))
      expect(sessions).toEqual([`${id}@${file}`])
      expect(events.map((event) => event.kind)).toEqual([
        'session_started',
        'prompt_submitted',
        'turn_completed',
      ])
      expect(obs.path).toBe(file)

      // An append lands as new events without re-reading the head.
      await writeFile(file, `${JSON.stringify(entry({ role: 'user', content: 'again' }))}\n`, {
        flag: 'a',
      })
      await waitFor(() => events.length === 4)
      expect(events.at(-1)?.kind).toBe('prompt_submitted')
    } finally {
      obs.stop()
    }
  })

  it('without an id, binds the newest session file created after spawn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-pi-state-'))
    const cwd = '/work/pi'
    const bucket = piSessionDir(cwd, home)
    await mkdir(bucket, { recursive: true })
    const stale = join(bucket, '2020-01-01T00-00-00-000Z_old-id.jsonl')
    await writeFile(stale, '{"type":"session","id":"old-id"}\n')
    const startedAtMs = Date.now() + 60_000 // the old file predates the spawn by far

    const sessions: string[] = []
    const obs = observePiState({
      cwd,
      homeDir: home,
      startedAtMs,
      pollMs: 15,
      onSession: (sessionId) => sessions.push(sessionId),
      onEvents: () => {},
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(sessions).toEqual([])
      const fresh = join(bucket, '2026-09-02T10-00-00-000Z_new-id.jsonl')
      await writeFile(fresh, '{"type":"session","id":"new-id"}\n')
      const future = new Date(startedAtMs + 1000)
      const { utimes } = await import('node:fs/promises')
      await utimes(fresh, future, future)
      await waitFor(() => sessions.length === 1)
      expect(sessions).toEqual(['new-id'])
    } finally {
      obs.stop()
    }
  })
})

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
