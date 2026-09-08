import { asSessionId } from '@podium/model'
import type { TurnReceipt } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReceiptSender, type ReceiptSenderPorts, type ReceiptSendInput, type ReceiptSendVia } from './receipt-send'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const accepted: TurnReceipt = {
  outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready', provenBy: 'hook', at: 'now',
}

function sender(receipt: Promise<TurnReceipt>, overrides: Partial<ReceiptSenderPorts> = {}) {
  return new ReceiptSender({
    prepareSend: async () => {},
    legacy: {
      sendText: async () => ({ ok: true }),
      queueText: async () => ({ ok: true }),
      interruptText: async () => ({ ok: true }),
      resumeAndSend: async () => ({ ok: true }),
    },
    contract: { send: () => receipt },
    queue: { enqueue: async () => ({ ok: true, position: 1 }) },
    onContract: () => true,
    liveWithEmptyQueue: () => true,
    queueNotEmpty: () => false,
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
  it('reports reconciliation failure after admission without waiting for the receipt or reconciler', async () => {
    const receipt = deferred<TurnReceipt>()
    const reconciliation = deferred<void>()
    // The test owns rejection cleanup only. Its evidence is the operator report,
    // never the absence of an unhandled rejection (which this catch would mask).
    void reconciliation.promise.catch(() => {})
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    let called = false
    const input = { sessionId: asSessionId('receipt-target'), sourceMessageId: 'message-1', text: 'private body' }
    const result = await sender(receipt.promise).send('now', input, () => {
      called = true
      return reconciliation.promise
    })
    expect(result).toEqual({ ok: true })
    expect(called).toBe(false)
    receipt.resolve(accepted)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(called).toBe(true)
    expect(report).not.toHaveBeenCalled()
    const failure = new Error('receipt ledger unavailable')
    reconciliation.reject(failure)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(
      '[receipt-send] reconciliation failed',
      expect.objectContaining({ sessionId: input.sessionId, sourceMessageId: input.sourceMessageId, via: 'now', operationId: input.sourceMessageId, outcome: 'accepted', error: failure }),
    )
  })

  const branches: Array<{ name: string; via: ReceiptSendVia; input?: Partial<ReceiptSendInput>; ports?: Partial<ReceiptSenderPorts>; daemonFails?: boolean }> = [
    { name: 'daemon rejection', via: 'now', daemonFails: true },
    { name: 'durable queue acceptance', via: 'queue' },
    { name: 'durable queue refusal', via: 'queue', ports: { queue: { enqueue: async () => ({ ok: false, reason: 'not_running' }) } } },
    { name: 'attachment refusal', via: 'now', input: { attachments: [{ id: 'bad', path: '/wrong/file', filename: 'bad.png', mediaType: 'image/png', kind: 'image' }] } },
  ]
  for (const branch of branches) {
    it(`reports asynchronous reconciliation failure for ${branch.name}`, async () => {
      const receipt = deferred<TurnReceipt>()
      const reconciliation = deferred<void>()
      void reconciliation.promise.catch(() => {})
      const report = vi.spyOn(console, 'error').mockImplementation(() => {})
      const input = { sessionId: asSessionId('receipt-target'), sourceMessageId: 'message-branch', text: 'private body', ...branch.input }
      let called = false
      await sender(receipt.promise, branch.ports).send(branch.via, input, () => {
        called = true
        return reconciliation.promise
      })
      if (branch.daemonFails) receipt.reject(new Error('daemon offline'))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(called).toBe(true)
      const failure = new Error('reconciliation storage unavailable')
      reconciliation.reject(failure)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(report).toHaveBeenCalledTimes(1)
      expect(report).toHaveBeenCalledWith('[receipt-send] reconciliation failed', expect.objectContaining({
        sessionId: input.sessionId, sourceMessageId: input.sourceMessageId, via: branch.via, error: failure,
      }))
      expect(report.mock.calls[0]?.[1]).not.toHaveProperty('text')
    })
  }

  it('reports synchronous reconciliation throws without rejecting queue admission', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('synchronous reconciliation failure')
    expect(await sender(Promise.resolve(accepted)).send('queue', {
      sessionId: asSessionId('receipt-target'), text: 'body',
    }, () => { throw failure })).toEqual({ ok: true, queued: true, position: 1 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(report).toHaveBeenCalledWith('[receipt-send] reconciliation failed', expect.objectContaining({
      operationId: expect.any(String), error: failure,
    }))
  })

})
