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

import {
  asSessionId,
  asThreadId,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_PENDING,
  type SessionId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { countStatements } from '../test-support/statement-count'
import { storeSql } from '../test-support/store-sql'
import { probeStatements } from './executor/statement-probe'
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
  const id = overrides.id ?? `m${String(n++).padStart(3, '0')}`
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

/** The original OR as an independent result oracle, on either engine. */
async function originalProof(session: SessionId): Promise<string[]> {
  const rows = await storeSql(store).all<{ id: string }>(sql`
    SELECT id FROM messages WHERE workspace_id = ${SELF_HOSTED_WORKSPACE_ID} AND (
      (delivery_status IN (${sql.join(
        MESSAGE_PENDING.map((status) => sql`${status}`),
        sql`, `,
      )})
        AND ((to_kind = 'session' AND to_id = ${session}) OR delivered_to = ${session}))
      OR (delivery_status = 'confirmed' AND delivered_to = ${session}
        AND acked_by IS NULL AND expects_response = true
        AND (expires_at IS NULL OR expires_at > ${NOW}))
    ) ORDER BY created_at, id
  `)
  return rows.map((row) => row.id)
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
    // Neither a different session's request nor a request expiring exactly now belongs to A.
    await message({ deliveryStatus: 'stored', toId: asSessionId('ses_other') })
    await message({
      deliveryStatus: 'confirmed',
      toId: A,
      deliveredTo: asSessionId('ses_other'),
      expectsResponse: true,
    })
    await message({
      deliveryStatus: 'confirmed',
      toId: A,
      deliveredTo: A,
      expectsResponse: true,
      expiresAt: NOW,
    })

    const batched = await messages.pendingForSessionsProof(sessions, NOW)
    for (const session of sessions) {
      const expected = await originalProof(session)
      expect(expected.length).toBeGreaterThan(0)
      expect(
        (await messages.pendingForSessionProof(session, NOW)).map((row) => row.id),
        session,
      ).toEqual(expected)
      expect(
        (batched.get(session) ?? []).map((row) => row.id),
        session,
      ).toEqual(expected)
    }
    expect([...batched.keys()].sort()).toEqual([...sessions].sort())
  })

  it('answers an empty list for a session with nothing pending', async () => {
    await message({ deliveryStatus: 'cancelled', toId: A })
    expect(await messages.pendingForSessionsProof([A], NOW)).toEqual(new Map([[A, []]]))
  })

  it('de-duplicates both arms and keeps SQL delivery order, including tied ids', async () => {
    for (const id of ['m_a', 'm-a', 'mA', 'ma', 'm\u{10000}', 'm\ue000']) {
      await message({ id, toId: A, deliveredTo: A, createdAt: at(2) })
    }
    await message({ id: 'newer', toId: A, createdAt: at(3) })
    await message({ id: 'older', toId: A, createdAt: at(1) })
    const expected = ['older', 'm-a', 'mA', 'm_a', 'ma', 'm\ue000', 'm\u{10000}', 'newer']
    expect(await originalProof(A)).toEqual(expected)
    expect((await messages.pendingForSessionProof(A, NOW)).map((row) => row.id)).toEqual(expected)
    expect(
      (await messages.pendingForSessionsProof([A, A], NOW)).get(A)?.map((row) => row.id),
    ).toEqual(expected)
  })

  it('attributes rows across the 500-session chunk boundary with one statement per chunk', async () => {
    const sessions = Array.from({ length: 501 }, (_, i) => asSessionId(`ses_${i}`))
    await message({ id: 'both-chunks', toId: sessions[0], deliveredTo: sessions[500] })
    const { result, statements } = await countStatements(store, () =>
      messages.pendingForSessionsProof([...sessions, asSessionId('ses_0')], NOW),
    )
    expect(statements).toBe(2)
    expect(result.size).toBe(501)
    for (const [session, rows] of result) {
      expect(rows.map((row) => row.id)).toEqual(
        session === sessions[0] || session === sessions[500] ? ['both-chunks'] : [],
      )
    }
    expect(
      await countStatements(store, () => messages.pendingForSessionsProof([], NOW)),
    ).toMatchObject({ statements: 0, result: new Map() })
  })

  it('keeps statement and transferred-row work flat as unrelated message history grows', async () => {
    await message({ id: 'addressed-and-handed', toId: A, deliveredTo: A })
    await message({ id: 'handed', toKind: 'issue', deliveredTo: A })
    await message({
      id: 'owed',
      toKind: 'issue',
      deliveredTo: A,
      deliveryStatus: 'confirmed',
      expectsResponse: true,
    })
    await message({
      id: 'owed-later',
      toKind: 'issue',
      deliveredTo: A,
      deliveryStatus: 'confirmed',
      expectsResponse: true,
      expiresAt: at(9),
    })
    // Even the addressed session's own confirmed rows do not owe it a reply unless
    // handed to it. The large fixture grows other sessions' history, not its own.
    await message({
      id: 'elsewhere',
      toId: A,
      deliveredTo: B,
      deliveryStatus: 'confirmed',
      expectsResponse: true,
    })
    const work: { history: number; single: number; batch: number; rows: number[] }[] = []
    for (const history of [1, 10_000]) {
      await storeSql(store).run(sql`
        WITH RECURSIVE n(value) AS (
          SELECT CAST(${history === 1 ? 1 : 2} AS INTEGER)
          UNION ALL SELECT value + 1 FROM n WHERE value < ${history}
        ) INSERT INTO messages (
          workspace_id, id, thread_id, from_kind, to_kind, to_id, kind, urgency,
          lifecycle, body, created_at, delivery_status, delivered_to, expects_response
        ) SELECT ${SELF_HOSTED_WORKSPACE_ID}, 'history-' || value, 'thread-' || value,
          'agent', 'session', 'outside-' || value, 'message', 'fyi', 'wait', 'history',
          ${at(1)}, CASE WHEN value % 3 = 0 THEN 'stored' ELSE 'confirmed' END,
          'outside-' || value, true FROM n
      `)
      const rows: number[] = []
      const detach = probeStatements(store.database, (statement) => rows.push(statement.rows))
      try {
        const single = await countStatements(store, () => messages.pendingForSessionProof(A, NOW))
        const batch = await countStatements(store, () =>
          messages.pendingForSessionsProof([A, C], NOW),
        )
        expect(single.result.map((row) => row.id)).toEqual(await originalProof(A))
        expect(single.result).toHaveLength(4)
        expect(batch.result.get(A)).toEqual(single.result)
        expect(batch.result.get(C)).toEqual([])
        // Capture only the two production reads, excluding the result oracle.
        work.push({
          history,
          single: single.statements,
          batch: batch.statements,
          rows: rows.slice(0, 2),
        })
      } finally {
        detach()
      }
    }
    expect(work).toEqual([
      { history: 1, single: 1, batch: 1, rows: [5, 5] },
      { history: 10_000, single: 1, batch: 1, rows: [5, 5] },
    ])
    console.log('pending proof statement/transfer work:', JSON.stringify(work))
  })
})
