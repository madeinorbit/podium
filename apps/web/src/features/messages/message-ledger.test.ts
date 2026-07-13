import { describe, expect, it } from 'vitest'
import {
  clampSummary,
  deliveryLine,
  type LedgerMessage,
  ledgerStatusTone,
} from './message-ledger'

const base: LedgerMessage = {
  id: 'msg_1',
  threadId: 'msg_1',
  inReplyTo: null,
  from: 'issue:#212',
  to: 'issue:#228',
  kind: 'message',
  urgency: 'next-turn',
  lifecycle: 'wait',
  body: 'hi',
  createdAt: '2026-07-13T00:00:00.000Z',
  status: 'queued',
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
    expect(ledgerStatusTone('queued')).toBe('queued')
    expect(ledgerStatusTone('delivered')).toBe('ok')
    expect(ledgerStatusTone('expired')).toBe('dead')
    expect(ledgerStatusTone('cancelled')).toBe('dead')
  })
  it('tells the delivery story', () => {
    expect(deliveryLine(base)).toBe('queued')
    expect(deliveryLine({ ...base, status: 'expired' })).toBe('expired undelivered')
    expect(
      deliveryLine({
        ...base,
        status: 'delivered',
        deliveredTo: 's1',
        ackedBy: 'msg_ack',
      }),
    ).toBe('delivered to s1 · acked by msg_ack')
  })
})
