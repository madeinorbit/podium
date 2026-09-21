import { describe, expect, it, vi } from 'vitest'
import handshake from './__fixtures__/handshake.json' with { type: 'json' }
import fixture from './__fixtures__/unknown-method.json' with { type: 'json' }
import { createCodexClient } from './client.js'

describe('unknown inbound methods', () => {
  it('diagnoses each method once and continues dispatching requests, notifications and responses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let receive = (_frame: unknown): void => {}
    const writes: string[] = []
    const onServerRequest = vi.fn()
    const onNotification = vi.fn()
    const client = createCodexClient({
      sessionId: 'session-diagnostic',
      transport: {
        write: (line) => {
          writes.push(line)
        },
        onLine: (handler) => {
          receive = (frame) => handler.line(JSON.stringify(frame))
        },
        close() {},
      },
      onServerRequest,
      onNotification,
    })
    try {
      const initialized = client.handshake(handshake.initializeRequest.params)
      receive(handshake.initializeResponse)
      // Deliberately before awaiting initialize: same-batch traffic knows the version.
      receive(fixture.request)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenLastCalledWith(expect.any(String), {
        method: fixture.request.method,
        harnessVersion: '0.147.0',
        sessionId: 'session-diagnostic',
      })
      receive({ ...fixture.request, id: 901 })
      receive({ method: fixture.request.method })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(onServerRequest).toHaveBeenCalledTimes(2)
      receive(fixture.notification)
      receive(fixture.notification)
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ method: fixture.notification.method }),
      )
      await initialized
      const before = onNotification.mock.calls.length
      receive({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } },
      })
      expect(onNotification).toHaveBeenCalledTimes(before + 1)
      const result = client.call('thread/read', {})
      const outgoing = JSON.parse(writes.at(-1) ?? '{}')
      receive({ id: outgoing.id, result: { alive: true } })
      await expect(result).resolves.toEqual({ alive: true })
      expect(client.ready).toBe(true)
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      client.close()
      warn.mockRestore()
    }
  })
})
