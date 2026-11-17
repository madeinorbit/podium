/**
 * THE BATCHED PROOF READ ANSWERS EACH SESSION AS THE ONE-SESSION READ DOES
 * (POD-7036).
 *
 * The host sample proves every idle candidate on a machine together, so
 * `pendingForSessionsProof` replaced one `pendingForSessionProof` per session
 * (the POD-7027 audit's burst `#3d3edfd1`). It re-states, in JavaScript, which
 * rows reach which session, because one row can name two sessions of the set
 * (addressed to one, handed to another). This holds it to the one-session read
 * over every status, both ways a row names a session, an owed reply, an acked
 * one and an expired one.
 */

import { asSessionId, asThreadId, MESSAGE_DELIVERY_STATUSES, type SessionId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { fixtureWriteScope } from '@podium/sync/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { MessagesRepository } from './messages'
import type { MessageRow } from './types'

let db: SqlDatabase
let messages: MessagesRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  const queries = createBunStoreExecutor({ database: db }).queries
  if (!queries) throw new Error('the synchronous query capability is absent on this handle')
  messages = new MessagesRepository(queries)
})

const A = asSessionId('ses_a')
const B = asSessionId('ses_b')
const C = asSessionId('ses_c')
const NOW = 't5'

let n = 0
async function message(overrides: Partial<MessageRow>): Promise<void> {
  const id = `m${String(n++).padStart(3, '0')}`
  const row: MessageRow = {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: null,
    toKind: 'session',
    toId: A,
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: id,
    expiresAt: null,
    createdAt: `t${n % 4}`,
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    expectsResponse: false,
    ...overrides,
  }
  const { deliveryStatus, ...rest } = row
  await messages.addMessage(fixtureWriteScope(), { ...rest, deliveryStatus: 'stored' })
  db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run(deliveryStatus, id)
}

describe('pendingForSessionsProof (POD-7036)', () => {
  it('gives each session of a set exactly the rows the one-session read gives it', async () => {
    const sessions: SessionId[] = [A, B, C]
    for (const status of MESSAGE_DELIVERY_STATUSES) {
      for (const to of sessions) {
        // Addressed to a session, handed to another, owed a reply or not.
        await message({ deliveryStatus: status, toId: to })
        await message({ deliveryStatus: status, toId: to, deliveredTo: to === A ? B : A })
        await message({ deliveryStatus: status, toId: to, deliveredTo: to, expectsResponse: true })
        await message({
          deliveryStatus: status,
          toId: to,
          deliveredTo: to,
          expectsResponse: true,
          ackedBy: 'someone',
        })
        await message({
          deliveryStatus: status,
          toId: to,
          deliveredTo: to,
          expectsResponse: true,
          expiresAt: 't1',
        })
        await message({
          deliveryStatus: status,
          toId: to,
          deliveredTo: to,
          expectsResponse: true,
          expiresAt: 't9',
        })
        // Addressed to an issue but handed to the session.
        await message({ deliveryStatus: status, toKind: 'issue', toId: 'iss_x', deliveredTo: to })
      }
    }
    // A session outside the set still reads its own rows alone.
    await message({ deliveryStatus: 'stored', toId: asSessionId('ses_other') })

    const batched = await messages.pendingForSessionsProof(sessions, NOW)
    for (const session of sessions) {
      const single = (await messages.pendingForSessionProof(session, NOW))
        .map((row) => row.id)
        .sort()
      expect(single.length).toBeGreaterThan(0)
      expect((batched.get(session) ?? []).map((row) => row.id).sort(), session).toEqual(single)
    }
    expect([...batched.keys()].sort()).toEqual([...sessions].sort())
  })

  it('answers an empty list for a session with nothing pending', async () => {
    await message({ deliveryStatus: 'cancelled', toId: A })
    expect(await messages.pendingForSessionsProof([A], NOW)).toEqual(new Map([[A, []]]))
  })
})
