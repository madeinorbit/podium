/**
 * THE MESSAGE RECORD NAMES ITS HISTORY ENTRY, AGAINST THE REAL DATABASE
 * (POD-4774).
 *
 * The agent's machine reports which transcript item a delivered message became;
 * the record keeps it so the chat matches message to entry by id. It is a
 * first-writer-wins stamp beside the delivery status: it never moves the
 * status, a repeat changes nothing, and only the session the row was handed to
 * can name it.
 */

import { asSessionId, asThreadId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { MessagesRepository } from './messages'
import type { MessageRow } from './types'

const S1 = asSessionId('ses_one')
const S2 = asSessionId('ses_two')

let db: SqlDatabase
let messages: MessagesRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  const queries = createBunStoreExecutor({ database: db }).queries
  if (!queries) throw new Error('the synchronous query capability is absent on this handle')
  messages = new MessagesRepository(queries)
})

function row(id: string): MessageRow {
  return {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'operator',
    fromSession: null,
    fromIssue: null,
    toKind: 'session',
    toId: S1,
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: id,
    expiresAt: null,
    createdAt: 't0',
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    expectsResponse: false,
  }
}

describe('naming the entry a message became', () => {
  it('is read back on the record, beside a status it leaves alone', async () => {
    await messages.addMessage(row('msg_a'))
    await messages.markDelivered('msg_a', S1, 't1')
    expect(await messages.nameTranscriptItem('msg_a', S1, { id: 'entry-1', cursor: 'cur-1' })).toBe(
      true,
    )
    const record = await messages.getMessage('msg_a')
    expect(record?.transcriptItem).toEqual({ id: 'entry-1', cursor: 'cur-1' })
    expect(record?.deliveryStatus).toBe('confirmed')
  })

  it('lands before the confirmation too: a stamp, not a move', async () => {
    await messages.addMessage(row('msg_b'))
    await messages.markDispatched('msg_b', S1, 't1')
    expect(await messages.nameTranscriptItem('msg_b', S1, { id: 'entry-2' })).toBe(true)
    const record = await messages.getMessage('msg_b')
    expect(record?.transcriptItem).toEqual({ id: 'entry-2' })
    expect(record?.deliveryStatus).toBe('dispatched')
  })

  it('keeps the first naming; a repeat or a different entry changes nothing', async () => {
    await messages.addMessage(row('msg_c'))
    await messages.markDelivered('msg_c', S1, 't1')
    await messages.nameTranscriptItem('msg_c', S1, { id: 'entry-3' })
    expect(await messages.nameTranscriptItem('msg_c', S1, { id: 'entry-3' })).toBe(false)
    expect(await messages.nameTranscriptItem('msg_c', S1, { id: 'entry-other' })).toBe(false)
    expect((await messages.getMessage('msg_c'))?.transcriptItem).toEqual({ id: 'entry-3' })
  })

  it('is refused for a session the row was not handed to', async () => {
    await messages.addMessage(row('msg_d'))
    await messages.markDelivered('msg_d', S1, 't1')
    expect(await messages.nameTranscriptItem('msg_d', S2, { id: 'entry-4' })).toBe(false)
    expect((await messages.getMessage('msg_d'))?.transcriptItem).toBeUndefined()
  })

  it('names nothing for an id no message has (a turn that was never a message)', async () => {
    expect(await messages.nameTranscriptItem('turn_random', S1, { id: 'entry-5' })).toBe(false)
  })

  it('reads as unnamed until named', async () => {
    await messages.addMessage(row('msg_e'))
    expect(await messages.getMessage('msg_e')).not.toHaveProperty('transcriptItem')
  })
})
