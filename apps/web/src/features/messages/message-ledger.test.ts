import { asThreadId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { clampSummary, deliveryLine, type LedgerMessage, ledgerStatusTone } from './message-ledger'

const base: LedgerMessage = {
  id: 'msg_1',
  threadId: asThreadId('msg_1'),
  inReplyTo: null,
  from: 'issue:#212',
  to: 'issue:#228',
  kind: 'message',
  urgency: 'next-turn',
  lifecycle: 'wait',
  body: 'hi',
  createdAt: '2026-07-13T00:00:00.000Z',
  status: 'queued',
  deliveryStatus: 'stored',
  ackedBy: null,
  deliveredAt: null,
  deliveredTo: null,
  expiresAt: null,
  clampedFrom: null,
  hop: 0,
}

describe('clampSummary', () => {
  it('null when nothing was clamped', () => {
    expect(clampSummary(base)).toBeNull()
  })
  it('shows requested → effective per downgraded axis, with reasons', () => {
    const s = clampSummary({
      ...base,
      urgency: 'next-turn',
      lifecycle: 'wait',
      clampedFrom: JSON.stringify({
        urgency: 'interrupt',
        lifecycle: 'wake',
        reasons: ['peer messages never interrupt', 'wake cooldown'],
      }),
    })
    expect(s?.parts).toEqual(['interrupt → next-turn', 'wake → wait'])
    expect(s?.reasons).toHaveLength(2)
  })
  it('survives malformed clamp JSON', () => {
    expect(clampSummary({ ...base, clampedFrom: '{oops' })).toEqual({
      parts: ['clamped'],
      reasons: [],
    })
  })
})

describe('status + delivery line', () => {
  it('tones', () => {
    expect(ledgerStatusTone('stored')).toBe('queued')
    expect(ledgerStatusTone('dispatched')).toBe('queued')
    expect(ledgerStatusTone('unknown')).toBe('queued')
    expect(ledgerStatusTone('confirmed')).toBe('ok')
    expect(ledgerStatusTone('failed')).toBe('dead')
    expect(ledgerStatusTone('expired')).toBe('dead')
    expect(ledgerStatusTone('cancelled')).toBe('dead')
  })
  it('tells the delivery story', () => {
    expect(deliveryLine(base)).toBe('queued')
    expect(deliveryLine({ ...base, queuePosition: 2 })).toBe('queued · queue position 2')
    // An abandoned drain is TERMINAL, and the chip says which way it ended
    // [POD-2132, POD-2202] — "still queued" described a wait nobody was serving.
    expect(
      deliveryLine({
        ...base,
        deliveryStatus: 'failed',
        deliveryDeferredAt: '2026-08-16T18:00:00.000Z',
        deliveryDeferredReason: 'never-live',
      }),
    ).toBe('not delivered · session never became ready')
    expect(
      deliveryLine({
        ...base,
        deliveryStatus: 'failed',
        deliveryDeferredAt: '2026-08-16T18:00:00.000Z',
        deliveryDeferredReason: 'teardown',
      }),
    ).toBe('not delivered · session torn down')
    expect(deliveryLine({ ...base, deliveryStatus: 'failed' })).toBe('dead-lettered · target gone')
    expect(deliveryLine({ ...base, deliveryStatus: 'expired' })).toBe('expired undelivered')
    // AN ATTACHMENT THE DRIVER REFUSED IS NOT A VANISHED TARGET [POD-2574]. The
    // session behind this row is running and reachable; what failed is the send.
    // Before the server stamped a cause, this row arrived here with a null reason
    // and fell through to "target gone", so BOTH readers of this function — the
    // ledger view and the chat transcript, via chat.ts — told the user the one
    // thing that was not true. Pinned as a line rather than as a status because
    // the status was already right; the sentence was the bug.
    expect(
      deliveryLine({
        ...base,
        deliveryStatus: 'failed',
        deliveryDeferredAt: '2026-08-25T18:00:00.000Z',
        deliveryDeferredReason: 'delivery-failed',
      }),
    ).toBe('not delivered · delivery failed')
    // AN INJECTED-BUT-UNCONFIRMED DEAD LETTER IS NOT A VANISHED TARGET
    // [POD-4704]. The server stamps delivery-failed when it dead-letters a row
    // it typed but never saw confirmed — a message cut off mid-turn while its
    // session stayed alive (POD-4604 run 13). The ledger must render that
    // cause, never the target-gone fallback.
    {
      const unconfirmed = deliveryLine({
        ...base,
        deliveryStatus: 'failed',
        deliveredTo: 's1',
        deliveryDeferredAt: '2026-09-13T18:00:00.000Z',
        deliveryDeferredReason: 'delivery-failed',
      })
      expect(unconfirmed).toBe('not delivered · delivery failed')
      expect(unconfirmed).not.toContain('target gone')
    }
    expect(
      deliveryLine({
        ...base,
        deliveryStatus: 'confirmed',
        deliveredTo: 's1',
        ackedBy: 'msg_ack',
      }),
    ).toBe('delivered to s1 · acked by msg_ack')
    expect(
      deliveryLine({ ...base, deliveryStatus: 'confirmed', deliveredTo: 's1', readAt: 't2' }),
    ).toBe('read by s1')
    // Handed on is not delivered, and says so [POD-4765].
    expect(deliveryLine({ ...base, deliveryStatus: 'dispatched', deliveredTo: 's1' })).toBe(
      'handed on to s1 · not yet confirmed',
    )
    expect(deliveryLine({ ...base, deliveryStatus: 'typed', deliveredTo: 's1' })).toBe(
      'typed to s1 · not yet confirmed',
    )
    expect(deliveryLine({ ...base, deliveryStatus: 'unknown' })).toBe(
      'not confirmed · it may or may not have arrived',
    )
  })
})
