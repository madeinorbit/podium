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
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { storeSql } from '../test-support/store-sql'
import type { MessagesRepository } from './messages'
import type { MessageRow } from './types'

// On the run's engine (POD-7118): the store's own messages repository.
let store: SessionStore
let messages: MessagesRepository

beforeEach(async () => {
  store = await openTestStore(':memory:')
  messages = store.messages
})

afterEach(async () => {
  await store.close()
})

/** A time `s` seconds into the fixture's minute, in the form both engines store. */
const at = (s: number): string => `2026-11-17T10:00:0${s}.000Z`

const A = asSessionId('ses_a')
const B = asSessionId('ses_b')
const C = asSessionId('ses_c')
const NOW = at(5)

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
    createdAt: at(n % 4),
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
  await storeSql(store).run(
    sql`UPDATE messages SET delivery_status = ${deliveryStatus} WHERE id = ${id}`,
  )
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
          expiresAt: at(1),
        })
        await message({
          deliveryStatus: status,
          toId: to,
          deliveredTo: to,
          expectsResponse: true,
          expiresAt: at(9),
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
