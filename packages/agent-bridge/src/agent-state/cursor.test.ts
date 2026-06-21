import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyCursorIdleTranscript,
  cursorStateProvider,
  translateCursorRecord,
} from './cursor.js'

describe('cursorStateProvider', () => {
  it('needs no argv instrumentation', () => {
    expect(
      cursorStateProvider.instrumentation({
        endpointUrl: 'http://x',
        settingsPath: '/tmp/s',
      }),
    ).toEqual({ args: [] })
  })

  it('translates transcript records into state events', async () => {
    await expect(
      translateCursorRecord({
        role: 'user',
        message: { content: [{ type: 'text', text: 'go' }] },
      }),
    ).resolves.toEqual([{ kind: 'prompt_submitted' }])
    await expect(
      translateCursorRecord({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
    ).resolves.toEqual([{ kind: 'activity' }])
    await expect(translateCursorRecord({ type: 'turn_ended', status: 'success' })).resolves.toEqual(
      [{ kind: 'turn_completed', verdict: { kind: 'done' } }],
    )
  })

  it('stamps the record timestamp as event-time (at) so reattach replays carry the real time', async () => {
    const events = await translateCursorRecord({
      type: 'turn_ended',
      status: 'success',
      timestamp: '2026-06-12T15:00:00.000Z',
    })
    expect(events[0]?.at).toBe('2026-06-12T15:00:00.000Z')
  })

  it('classifies idle transcripts from the last assistant message', () => {
    expect(
      classifyCursorIdleTranscript([
        { role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'Should I continue?' }] } },
      ]),
    ).toEqual(expect.objectContaining({ kind: 'question' }))
  })

  it('bootEvents classify resumed sessions from disk', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-cursor-boot-'))
    const cwd = '/repo/cursor'
    const chatId = 'chat-1'
    const transcript = join(
      home,
      '.cursor',
      'projects',
      'repo-cursor',
      'agent-transcripts',
      chatId,
      `${chatId}.jsonl`,
    )
    await mkdir(join(transcript, '..'), { recursive: true })
    await writeFile(
      transcript,
      [
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'All done.' }] },
        }),
        JSON.stringify({ type: 'turn_ended', status: 'success' }),
      ].join('\n'),
    )

    const { mtime } = await stat(transcript)
    const events = await cursorStateProvider.bootEvents?.({
      cwd,
      resumeValue: chatId,
      homeDir: home,
    })
    expect(events).toEqual([
      { kind: 'turn_completed', verdict: { kind: 'done' }, at: mtime.toISOString() },
    ])
  })
})
