import { asSessionId, type MessageRecordWire, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { messageNoticeLine, messageNotices } from './message-notices'

const record = (id: string, over: Partial<MessageRecordWire> = {}): MessageRecordWire => ({
  id,
  sessionId: asSessionId('s1'),
  senderUserId: 'usr_me',
  body: `words of ${id}`,
  createdAt: '2026-09-29T10:00:00.000Z',
  status: 'failed',
  ...over,
})

describe('messages that did not arrive, anywhere in the app (POD-4764)', () => {
  it('lists failed, expired and unknown messages, newest first, and nothing still on its way', () => {
    const notices = messageNotices(
      [
        record('msg_failed', { createdAt: '2026-09-29T10:00:01.000Z' }),
        record('msg_expired', { status: 'expired', createdAt: '2026-09-29T10:00:03.000Z' }),
        record('msg_unknown', { status: 'unknown', createdAt: '2026-09-29T10:00:02.000Z' }),
        record('msg_typed', { status: 'typed' }),
        record('msg_confirmed', { status: 'confirmed' }),
      ],
      [{ sessionId: asSessionId('s1'), name: 'Fix the build', title: 't' } as SessionMeta],
    )
    expect(notices.map((notice) => notice.messageId)).toEqual([
      'msg_expired',
      'msg_unknown',
      'msg_failed',
    ])
    expect(notices[0]).toMatchObject({ sessionLabel: 'Fix the build', excerpt: 'words of msg_expired' })
  })

  // Carried over from the web's dead-letter mapper (POD-2574), which this
  // replaces: the settled message is what the user is left looking at, and
  // "target gone" said about a running session is a lie.
  it('does not tell the user the target is gone when a driver refused the message', () => {
    const line = messageNoticeLine({ status: 'failed', reason: 'delivery-failed' })
    expect(line).toBe('not delivered · delivery failed')
    expect(line).not.toContain('target gone')
  })

  it('still falls back to target gone when the row records no cause at all', () => {
    expect(messageNoticeLine({ status: 'failed' })).toBe('dead-lettered · target gone')
  })

  it('never calls an unknown message failed', () => {
    expect(messageNoticeLine({ status: 'unknown' })).toBe(
      'not confirmed — it may or may not have arrived',
    )
  })
})
