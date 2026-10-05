import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLogs } from '../../test-support/capture-logs'
import { ReceiptSender, type ReceiptSenderPorts, type ReceiptSendInput, type ReceiptSendVia } from './receipt-send'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function sender(overrides: Partial<ReceiptSenderPorts> = {}) {
  return new ReceiptSender({
    legacy: {
      sendText: async () => ({ ok: true }),
      queueText: async () => ({ ok: true }),
      interruptText: async () => ({ ok: true }),
      resumeAndSend: async () => ({ ok: true }),
    },
    queue: { enqueue: async () => ({ ok: true, position: 1 }) },
    onContract: () => true,
    systemPrincipal: () => ({
      kind: 'system', attribution: { actor: { kind: 'system', job: 'test' }, onBehalfOf: null },
      principalRef: 'test', delegation: null,
    }),
    now: () => 0,
    ...overrides,
  })
}

afterEach(() => vi.restoreAllMocks())

describe('detached receipt reconciliation', () => {
  const branches: Array<{
    name: string
    via: ReceiptSendVia
    input?: Partial<ReceiptSendInput>
    ports?: Partial<ReceiptSenderPorts>
  }> = [
    { name: 'durable queue acceptance', via: 'queue' },
    { name: 'interrupt row acceptance', via: 'interrupt' },
    { name: 'durable queue refusal', via: 'queue', ports: { queue: { enqueue: async () => ({ ok: false, reason: 'not_running' }) } } },
    { name: 'attachment refusal', via: 'now', input: { attachments: [{ id: 'bad', path: '/wrong/file', filename: 'bad.png', mediaType: 'image/png', kind: 'image' }] } },
  ]
  for (const branch of branches) {
    it(`reports asynchronous reconciliation failure for ${branch.name}`, async () => {
      const reconciliation = deferred<void>()
      void reconciliation.promise.catch(() => {})
      // The report routes through @podium/logger now; watch the logged
      // records rather than the console (POD-5614).
      const captured = captureLogs()
      try {
        const input = { sessionId: asSessionId('receipt-target'), sourceMessageId: 'message-branch', text: 'private body', ...branch.input }
        let called = false
        await sender(branch.ports).send(branch.via, input, () => {
          called = true
          return reconciliation.promise
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(called).toBe(true)
        const failure = new Error('reconciliation storage unavailable')
        reconciliation.reject(failure)
        await new Promise<void>((resolve) => setImmediate(resolve))
        const errors = captured.at('error')
        expect(errors).toHaveLength(1)
        expect(errors[0]?.msg).toBe('reconciliation failed')
        expect(errors[0]).toMatchObject({
          sessionId: input.sessionId, sourceMessageId: input.sourceMessageId, via: branch.via, error: failure,
        })
        expect(errors[0]).not.toHaveProperty('text')
      } finally {
        captured.restore()
      }
    })
  }

  it('reports synchronous reconciliation throws without rejecting queue admission', async () => {
    const captured = captureLogs()
    try {
      const failure = new Error('synchronous reconciliation failure')
      expect(
        await sender().send(
          'queue',
          {
            sessionId: asSessionId('receipt-target'),
            text: 'body',
          },
          () => {
            throw failure
          },
        ),
      ).toEqual({ ok: true, queued: true, position: 1 })
      await new Promise<void>((resolve) => setImmediate(resolve))
      const errors = captured.at('error')
      expect(errors).toHaveLength(1)
      expect(errors[0]?.msg).toBe('reconciliation failed')
      expect(errors[0]).toMatchObject({
        operationId: expect.any(String), error: failure,
      })
    } finally {
      captured.restore()
    }
  })

})
