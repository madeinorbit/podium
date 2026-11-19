/**
 * AN OOM DEATH SURVIVES THE ROUND TRIP (POD-2413).
 *
 * AGAINST THE REAL MIGRATED SCHEMA, for the reason the attribution suite states
 * next door: these run the SHIPPED migration manifest against an in-memory
 * database, so a missing column — or a CHECK that refuses the write — fails
 * HERE rather than in production. That is not hypothetical. The first cut of
 * this feature wrote `stop_reason = 'oom'`, which
 * `sessions_stop_reason_check` admits nothing of: every OOM death threw at the
 * database, the row never persisted its cause, and because the write is one
 * transaction with the durable event append, the `oomKilled` event went down
 * with it. A fake repository would have agreed with all of it.
 *
 * So the cause persists as its own timestamped fact beside an ordinary `exited`
 * row, and the CONCLUSION is re-derived on the way back in.
 */

import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drainedRepository } from '../test-support/drained-repository'
import { openSliceStore, type SliceStore } from '../test-support/pg-slice-tables'
import { storeTables } from './executor/sync-drizzle'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'

let slice: SliceStore
let sessions: SessionsRepository

// The self-hosted workspace's queries, as `SessionStore` builds them (POD-7015), on the
// run's engine: SQLite on the store shard, Postgres on `server-store-pg` (POD-6983).
beforeEach(async () => {
  slice = await openSliceStore()
  sessions = drainedRepository(slice, new SessionsRepository(slice.queries))
})

afterEach(async () => {
  await slice.close()
})

const DIED_AT = '2026-08-20T10:00:00.000Z'

const row = (id: string, extra: Partial<SessionRow>): SessionRow => ({
  id: asSessionId(id),
  ownerUserId: asUserId('user:alice'),
  agentKind: 'claude-code',
  cwd: '/home/u/repo',
  title: 'a session',
  name: null,
  nameSource: null,
  originKind: 'spawn',
  conversationId: null,
  resumeKind: null,
  resumeValue: null,
  status: 'exited',
  exitCode: 137,
  spawnFailure: null,
  durableLabel: `label-${id}`,
  createdAt: '2026-08-20T09:00:00.000Z',
  lastActiveAt: DIED_AT,
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: asMachineId('machine-1'),
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
  stoppedAt: DIED_AT,
  ...extra,
})

describe('an OOM death, durably', () => {
  it('writes a session the kernel killed instead of throwing on the stop-reason CHECK', async () => {
    // The regression: `stopReason: 'oom'` reaching the column at all.
    await sessions.upsertSession(
      fixtureWriteScope(),
      row('sess-oom', { stopReason: 'oom', oomKilledAt: DIED_AT }),
    )
  })

  it('keeps the kill time, and keeps the column inside its own vocabulary', async () => {
    await sessions.upsertSession(
      fixtureWriteScope(),
      row('sess-oom', { stopReason: 'oom', oomKilledAt: DIED_AT }),
    )
    const back = await sessions.getSession(asSessionId('sess-oom'))

    expect(back?.oomKilledAt).toBe(DIED_AT)
    // THE DEATH is what the enum column holds; the CAUSE is the timestamp
    // beside it. A row read back as 'oom' here would mean the CHECK is not
    // what this test believes it is.
    expect(back?.stopReason).toBe('exited')
    // The stored columns, read past the mapper, on the run's engine.
    const db = slice.queries.rootDb
    const t = storeTables(db)
    const raw = await db
      .select({ stop_reason: t.sessions.stopReason, oom_killed_at: t.sessions.oomKilledAt })
      .from(t.sessions)
      .where(eq(t.sessions.id, asSessionId('sess-oom')))
      .prepare()
      .get()
    expect(raw?.stop_reason).toBe('exited')
    expect(raw?.oom_killed_at).toBe(DIED_AT)
  })

  it('leaves an ordinary exit with no kill recorded', async () => {
    // The admission that pairs with the assertion above: the column is not
    // simply always set, so the previous test measures something.
    await sessions.upsertSession(
      fixtureWriteScope(),
      row('sess-clean', { stopReason: 'exited', exitCode: 0 }),
    )
    const back = await sessions.getSession(asSessionId('sess-clean'))
    expect(back?.oomKilledAt).toBeNull()
    expect(back?.stopReason).toBe('exited')
  })
})
