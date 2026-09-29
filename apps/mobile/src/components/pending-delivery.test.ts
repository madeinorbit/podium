/**
 * THE LINE UNDER A PHONE BUBBLE, FROM THE SERVER'S RECORD (POD-4885).
 *
 * The record goes through the same projection the chat uses, then through the
 * phone's row and its line — so a status reaches the words a person reads.
 */

import { projectConversation } from '@podium/client-core/conversation'
import { asSessionId, type MessageRecordWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { pendingMetaLine, pendingTurnOf } from './pending-delivery'

const record = (status: string, over: Partial<MessageRecordWire> = {}): MessageRecordWire => ({
  id: 'msg-1',
  sessionId: asSessionId('s1'),
  senderUserId: 'usr_me',
  body: 'the words',
  createdAt: '2026-09-29T10:00:00.000Z',
  status: status as MessageRecordWire['status'],
  ...over,
})

/** The phone's line for a message whose record says `status`. */
function lineFor(status: string, over: Partial<MessageRecordWire> = {}): string {
  const [bubble] = projectConversation({
    turns: [],
    records: [record(status, over)],
    transcript: [],
    seenOpen: new Set(),
    hidden: new Set(),
  })
  if (!bubble) throw new Error(`no bubble for a ${status} record`)
  return pendingMetaLine(pendingTurnOf(bubble))
}

describe('the line under a phone bubble', () => {
  it('says the agent has a message its program accepted', () => {
    expect(lineFor('accepted')).toBe('accepted by the agent')
  })

  it('keeps the words it had for the other statuses', () => {
    expect(lineFor('stored')).toBe('waiting its turn')
    expect(lineFor('dispatched')).toBe('sent')
    expect(lineFor('typed')).toBe('sent')
    expect(lineFor('unknown')).toBe('not confirmed')
    expect(lineFor('failed')).toBe('not delivered')
    expect(lineFor('cancelled')).toBe('retracted')
  })

  it('says a retract of an accepted message came too late', () => {
    expect(lineFor('accepted', { retractRequestedAt: '2026-09-29T10:00:01.000Z' })).toBe(
      'too late to retract — already typed',
    )
  })

  it('reads a status this build does not know as sent, and does not throw', () => {
    expect(lineFor('a-status-from-a-newer-server')).toBe('sent')
  })
})
