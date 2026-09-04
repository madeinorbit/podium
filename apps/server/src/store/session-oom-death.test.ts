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
import type { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'

/**
 * Stage A's synchronous drizzle seam, built the way `SessionStore` asserts it
 * [POD-3221 spec rule 27b]. A converted repository takes this in the slot its
 * executor occupied. Local to this file on purpose: hoisting it into
 * `test-support` would put six parallel conversion waves in one shared file.
 */
const stageDb = (database: ReturnType<typeof openDatabase>) => {
  const stage = createBunStoreExecutor({ database }).stageA
  if (!stage) throw new Error('the Stage A drizzle seam is absent on this handle')
  return stage.db
}

let db: ReturnType<typeof openDatabase>
let sessions: SessionsRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  sessions = new SessionsRepository(stageDb(db))
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
  it('writes a session the kernel killed instead of throwing on the stop-reason CHECK', () => {
    // The regression: `stopReason: 'oom'` reaching the column at all.
    expect(() =>
      sessions.upsertSession(row('sess-oom', { stopReason: 'oom', oomKilledAt: DIED_AT })),
    ).not.toThrow()
  })

  it('keeps the kill time, and keeps the column inside its own vocabulary', async () => {
    await sessions.upsertSession(row('sess-oom', { stopReason: 'oom', oomKilledAt: DIED_AT }))
    const back = await sessions.getSession(asSessionId('sess-oom'))

    expect(back?.oomKilledAt).toBe(DIED_AT)
    // THE DEATH is what the enum column holds; the CAUSE is the timestamp
    // beside it. A row read back as 'oom' here would mean the CHECK is not
    // what this test believes it is.
    expect(back?.stopReason).toBe('exited')
    const raw = db
      .prepare('SELECT stop_reason, oom_killed_at FROM sessions WHERE id = ?')
      .get('sess-oom') as { stop_reason: string; oom_killed_at: string }
    expect(raw.stop_reason).toBe('exited')
    expect(raw.oom_killed_at).toBe(DIED_AT)
  })

  it('leaves an ordinary exit with no kill recorded', async () => {
    // The admission that pairs with the assertion above: the column is not
    // simply always set, so the previous test measures something.
    await sessions.upsertSession(row('sess-clean', { stopReason: 'exited', exitCode: 0 }))
    const back = await sessions.getSession(asSessionId('sess-clean'))
    expect(back?.oomKilledAt).toBeNull()
    expect(back?.stopReason).toBe('exited')
  })
})
