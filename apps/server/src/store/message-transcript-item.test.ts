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

  it('is refused for a message that ended without being typed (POD-4840)', async () => {
    await messages.addMessage(row('msg_failed'))
    await messages.markDispatched('msg_failed', S1, 't1')
    await messages.markDeadLetter('msg_failed', 't2', 'never-live')
    await messages.addMessage(row('msg_cancelled'))
    await messages.markCancelled('msg_cancelled')
    for (const id of ['msg_failed', 'msg_cancelled']) {
      expect(await messages.nameTranscriptItem(id, S1, { id: 'entry-stray' })).toBe(false)
      expect((await messages.getMessage(id))?.transcriptItem).toBeUndefined()
    }
  })

  it('names nothing for an id no message has (a turn that was never a message)', async () => {
    expect(await messages.nameTranscriptItem('turn_random', S1, { id: 'entry-5' })).toBe(false)
  })

  it('reads as unnamed until named', async () => {
    await messages.addMessage(row('msg_e'))
    expect(await messages.getMessage('msg_e')).not.toHaveProperty('transcriptItem')
  })
})

/**
 * THE AGENT PROGRAM'S OWN IDS FOR A MESSAGE (POD-4841). Kept beside the entry
 * so the message can be looked up in the program's history later. A list that
 * only grows: ids arrive at different moments (the answer to the send, the
 * record after it), each is kept once, and nothing known is ever replaced.
 */
describe("keeping the agent program's own ids for a message", () => {
  const turn = { kind: 'codex-turn', id: 'turn-1' }
  const echo = { kind: 'codex-client-message', id: 'msg_h' }

  it('reads back the ids, beside a status they leave alone', async () => {
    await messages.addMessage(row('msg_h'))
    await messages.markDispatched('msg_h', S1, 't1')
    expect(await messages.recordHarnessRef('msg_h', S1, [turn])).toBe(true)
    const record = await messages.getMessage('msg_h')
    expect(record?.harnessRef).toEqual([turn])
    expect(record?.deliveryStatus).toBe('dispatched')
  })

  it('adds ids learned later, each once, in the order learned', async () => {
    await messages.addMessage(row('msg_h'))
    await messages.markDelivered('msg_h', S1, 't1')
    await messages.recordHarnessRef('msg_h', S1, [turn])
    expect(await messages.recordHarnessRef('msg_h', S1, [turn, echo])).toBe(true)
    expect(await messages.recordHarnessRef('msg_h', S1, [echo])).toBe(false)
    expect((await messages.getMessage('msg_h'))?.harnessRef).toEqual([turn, echo])
  })

  it('keeps the ids of an unconfirmed or failed message: a later look-up needs them most', async () => {
    await messages.addMessage(row('msg_u'))
    await messages.markDispatched('msg_u', S1, 't1')
    await messages.markDeadLetter('msg_u', 't2', 'delivery-failed')
    expect(await messages.recordHarnessRef('msg_u', S1, [turn])).toBe(true)
    expect((await messages.getMessage('msg_u'))?.harnessRef).toEqual([turn])
  })

  it('is refused for another session, and for a message that was never typed', async () => {
    await messages.addMessage(row('msg_other'))
    await messages.markDelivered('msg_other', S1, 't1')
    expect(await messages.recordHarnessRef('msg_other', S2, [turn])).toBe(false)
    await messages.addMessage(row('msg_cancelled'))
    await messages.markCancelled('msg_cancelled')
    expect(await messages.recordHarnessRef('msg_cancelled', S1, [turn])).toBe(false)
    for (const id of ['msg_other', 'msg_cancelled']) {
      expect(await messages.getMessage(id)).not.toHaveProperty('harnessRef')
    }
  })

  it('writes nothing for no ids or an unknown message, and reads as none until given', async () => {
    await messages.addMessage(row('msg_e'))
    expect(await messages.recordHarnessRef('msg_e', S1, [])).toBe(false)
    expect(await messages.recordHarnessRef('turn_random', S1, [turn])).toBe(false)
    expect(await messages.getMessage('msg_e')).not.toHaveProperty('harnessRef')
  })

  it('reads a stored list it cannot parse as none, never as a failed read', async () => {
    await messages.addMessage(row('msg_bad'))
    db.exec(`UPDATE messages SET harness_ref_json = 'not json' WHERE id = 'msg_bad'`)
    expect(await messages.getMessage('msg_bad')).not.toHaveProperty('harnessRef')
    // And a later id still lands, replacing what could not be read.
    expect(await messages.recordHarnessRef('msg_bad', S1, [turn])).toBe(true)
    expect((await messages.getMessage('msg_bad'))?.harnessRef).toEqual([turn])
  })
})
