/**
 * WHERE A PHONE SEND GOES (POD-4762).
 *
 * Every send goes through the outbox; the route only picks the command. A live
 * session types, a parked one wakes first, and a session that takes no text
 * fails with the composer's own reason rather than queueing a send the server
 * would refuse.
 */
import { describe, expect, it } from 'vitest'
import { chatSendTransport } from './chat-send-transport'

describe('chatSendTransport', () => {
  it('sends to a live session without waking it', () => {
    expect(chatSendTransport({ sendable: true, canResume: false })).toEqual({
      kind: 'send',
      wake: false,
    })
  })

  it('wakes a parked session that can resume', () => {
    expect(chatSendTransport({ sendable: false, canResume: true })).toEqual({
      kind: 'send',
      wake: true,
    })
  })

  it('refuses a session that takes no text with the composers reason', () => {
    expect(
      chatSendTransport({
        sendable: false,
        canResume: false,
        refusalReason: 'Session is archived.',
      }),
    ).toEqual({ kind: 'refused', reason: 'Session is archived.' })
  })

  it('refuses without a reason rather than queueing into a dead letter', () => {
    expect(chatSendTransport({ sendable: false, canResume: false })).toEqual({
      kind: 'refused',
      reason: 'Session is not running.',
    })
  })
})
