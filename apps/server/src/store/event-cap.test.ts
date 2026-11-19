/**
 * THE EVENT-LOG ROW CAP IS FOUND BY A SEEK (POD-7035, audit finding 7).
 *
 * `planEventPrune` names the newest event beyond the newest `maxRows`. It used to
 * walk `maxRows` table rows (`ORDER BY id DESC LIMIT 1 OFFSET maxRows`, a plan of
 * `SCAN podium_events`): about 0.9 s a call on the operator's 150 MB log, under
 * the server's event loop. The cut must stay exact when ids are missing above
 * it, so it is checked against that walk as the oracle, gaps and all.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { probeStatements, type StatementProbeHolder } from './executor'

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function seeded(rows: number): Promise<{ store: SessionStore; db: SqlDatabase }> {
  store = await openTestStore(':memory:')
  const db = (store as unknown as { db: SqlDatabase }).db
  const insert = db.prepare(
    "INSERT INTO podium_events (workspace_id, ts, kind, subject, payload) VALUES (?, ?, ?, 'subject', '{}')",
  )
  for (let i = 0; i < rows; i += 1) {
    insert.run(
      SELF_HOSTED_WORKSPACE_ID,
      `2099-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      i % 3 === 0 ? 'a' : 'b',
    )
  }
  return { store, db }
}

/** The old statement, kept here as the oracle the seek must agree with. */
const walkedCut = (db: SqlDatabase, maxRows: number): number =>
  (
    db
      .prepare(
        'SELECT id FROM podium_events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
      )
      .get(SELF_HOSTED_WORKSPACE_ID, maxRows) as { id: number } | undefined
  )?.id ?? 0

const cutOf = async (s: SessionStore, maxRows: number): Promise<number> =>
  (await s.events.planEventPrune({ maxAgeDays: 3650, maxRows })).capThroughId

describe('the event-log row cap (POD-7035)', () => {
  it('agrees with the walk when the ids are dense', async () => {
    const { store: s, db } = await seeded(200)
    for (const maxRows of [0, 1, 50, 199, 200, 201, 500]) {
      expect(await cutOf(s, maxRows), `maxRows ${maxRows}`).toBe(walkedCut(db, maxRows))
    }
  })

  it('agrees with the walk when ids are missing above, at and below the guess', async () => {
    const { store: s, db } = await seeded(200)
    // Gaps in the young range (an aged-out row the agent dated old), a run of
    // them, and gaps below where the guess lands.
    db.prepare(
      'DELETE FROM podium_events WHERE id IN (190, 185, 184, 183, 170, 151, 150, 149, 120, 3, 4)',
    ).run()
    for (const maxRows of [0, 1, 10, 30, 49, 50, 51, 100, 188, 189, 190, 300]) {
      expect(await cutOf(s, maxRows), `maxRows ${maxRows}`).toBe(walkedCut(db, maxRows))
    }
  })

  it('reads no table row to find the cut', async () => {
    const { store: s, db } = await seeded(200)
    const statements: string[] = []
    const detach = probeStatements(s as unknown as StatementProbeHolder, (observation) => {
      if (/podium_events/i.test(observation.sql)) statements.push(observation.sql)
    })
    try {
      await cutOf(s, 50)
    } finally {
      detach()
    }
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as { detail: string }[])
        .map((row) => row.detail)
        .join(' | ')
      // A walk of the table itself; a covering index or a primary-key seek is fine.
      expect(plan, statement).not.toMatch(/SCAN podium_events(?! USING COVERING INDEX)/)
    }
  })
})
