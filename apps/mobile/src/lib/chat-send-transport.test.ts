/**
 * WHERE A PHONE SEND GOES (POD-4688).
 *
 * A live session hands its send to the server at once (direct `sendText`,
 * like the desktop chat) instead of queueing it behind the durable outbox.
 * Parked sessions keep the wake path, offline taps keep the held path, and a
 * session that takes no text fails with the composer's own reason rather than
 * queueing a send the server would dead-letter.
 */
import { describe, expect, it } from 'vitest'
import { chatSendTransport, queuedDeliveryOf } from './chat-send-transport'

describe('chatSendTransport', () => {
  it('sends a live session straight through while online', () => {
    expect(chatSendTransport({ sendable: true, canResume: false, connected: true })).toEqual({
      kind: 'direct',
    })
  })

  it('queues a live-session send while offline instead of failing it', () => {
    expect(chatSendTransport({ sendable: true, canResume: false, connected: false })).toEqual({
      kind: 'outbox',
    })
  })

  it('keeps the parked wake path on the outbox, online or offline', () => {
    expect(chatSendTransport({ sendable: false, canResume: true, connected: true })).toEqual({
      kind: 'outbox',
    })
    expect(chatSendTransport({ sendable: false, canResume: true, connected: false })).toEqual({
      kind: 'outbox',
    })
  })

  it('refuses a session that takes no text with the composers reason', () => {
    expect(
      chatSendTransport({
        sendable: false,
        canResume: false,
        refusalReason: 'Session is archived.',
        connected: true,
      }),
    ).toEqual({ kind: 'refused', reason: 'Session is archived.' })
  })

  it('refuses without a reason rather than queueing into a dead letter', () => {
    expect(chatSendTransport({ sendable: false, canResume: false, connected: true })).toEqual({
      kind: 'refused',
      reason: 'Session is not running.',
    })
  })
})

describe('queuedDeliveryOf', () => {
  it('reads a queued acceptance with its FIFO position', () => {
    expect(
      queuedDeliveryOf({ ok: true, queued: true, disposition: 'queued', position: 2 }),
    ).toEqual({
      state: 'queued',
      position: 2,
    })
  })

  it('reads a queued acceptance without a position', () => {
    expect(queuedDeliveryOf({ ok: true, queued: true, disposition: 'queued' })).toEqual({
      state: 'queued',
    })
  })

  it('a delivered send is not a queued one', () => {
    expect(queuedDeliveryOf({ ok: true, disposition: 'delivered' })).toBeNull()
    expect(queuedDeliveryOf({ ok: true })).toBeNull()
    expect(queuedDeliveryOf(null)).toBeNull()
    expect(queuedDeliveryOf('ok')).toBeNull()
  })
})
