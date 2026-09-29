import { describe, expect, it } from 'vitest'
import handshake from './__fixtures__/handshake.json' with { type: 'json' }
import { createCodexClient } from './client.js'

/**
 * WHAT CAME BEFORE AN ANSWER (POD-4849). Codex answers `turn/start` and then
 * announces the turn it opened; a turn someone else opened is announced BEFORE
 * the answer. Both can be read in one go, and a promise continuation runs only
 * after all of them — so the driver reads the session at the answer, through
 * `onAnswer`, which runs before the next frame is dispatched.
 */
describe('the moment an answer is read', () => {
  it('runs `onAnswer` after the frames before the answer and before the frames after it', async () => {
    let receive = (_frame: unknown): void => {}
    const writes: string[] = []
    const seen: string[] = []
    const client = createCodexClient({
      sessionId: 'session-answer',
      transport: {
        write: (line) => {
          writes.push(line)
        },
        onLine: (handler) => {
          receive = (frame) => handler.line(JSON.stringify(frame))
        },
        close() {},
      },
      onServerRequest: () => {},
      onNotification: (note) => {
        if (note.method === 'turn/started') seen.push(`started ${note.params.turn.id}`)
      },
    })
    try {
      const initialized = client.handshake(handshake.initializeRequest.params)
      receive(handshake.initializeResponse)
      await initialized
      const answered = client.call('turn/start', {}, { onAnswer: () => void seen.push('answer') })
      const outgoing = JSON.parse(writes.at(-1) ?? '{}')
      const started = (id: string) => ({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id, status: 'inProgress' } },
      })
      // One read: another client's turn, the answer, then our own turn.
      receive(started('turn-theirs'))
      receive({ id: outgoing.id, result: { turn: { id: 'turn-theirs' } } })
      receive(started('turn-ours'))
      expect(seen).toEqual(['started turn-theirs', 'answer', 'started turn-ours'])
      await expect(answered).resolves.toEqual({ turn: { id: 'turn-theirs' } })

      // An error answer is no answer.
      const refused = client.call('turn/start', {}, { onAnswer: () => void seen.push('refused') })
      const second = JSON.parse(writes.at(-1) ?? '{}')
      receive({ id: second.id, error: { code: -32600, message: 'no' } })
      await expect(refused).rejects.toThrow()
      expect(seen).not.toContain('refused')
    } finally {
      client.close()
    }
  })
})
