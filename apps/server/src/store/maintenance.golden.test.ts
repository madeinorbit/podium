/**
 * The maintenance aggregate's behaviour as it is TODAY, pinned before the
 * drizzle conversion [POD-3394, method §3 checklist item 10].
 *
 * The coverage census (POD-3244) has `getLease`, `putLease` and
 * `pruneCommandsBatch` in its "executed, but never named" column — they reach a
 * test only through `modules/maintenance/service.ts`. `getCommand` and
 * `recordCommand` are named there and are pinned here anyway, because the four
 * of them share the two tables and a conversion touches them together.
 *
 * THE THREE SITES WHERE THE OBVIOUS CONVERSION IS NOT THE CURRENT BEHAVIOUR:
 *
 *   - `getLease` returns `undefined` for a missing lease. `LocksRepository`
 *     returns `null` from the same shape one file over, and the two are not
 *     interchangeable to a caller writing `=== undefined`.
 *   - `pruneCommandsBatch` deletes rows STRICTLY before the cutoff, in a
 *     deterministic order, and at most `batchSize` of them. All three are load
 *     bearing: the bound is what keeps the prune off the write lane for long,
 *     and the order is what makes a repeated prune walk the ledger's head
 *     instead of revisiting the same rows.
 *   - `getCommand` parses the stored JSON through the protocol schema, so a row
 *     that is not a valid reply THROWS rather than being quarantined. That is
 *     deliberate for an idempotency ledger the server itself wrote, and it is
 *     the behaviour a conversion must keep (spec §6 rule 4: decided per column,
 *     and this one is not among the oracle's quarantining columns).
 */

import type { MaintenanceCommandReply } from '@podium/protocol'
import { expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import type { MaintenanceLeaseRow } from './maintenance'

/**
 * The raw connection, for planting a value no typed writer can produce.
 * Same shape and same justification as `store/json-column-corruption-oracle.test.ts`.
 */
interface RawStatement {
  run(...params: (string | number | null)[]): unknown
}
const rawDb = (store: SessionStore): { prepare(sql: string): RawStatement } =>
  (store as unknown as { db: { prepare(sql: string): RawStatement } }).db

function lease(overrides: Partial<MaintenanceLeaseRow> = {}): MaintenanceLeaseRow {
  return {
    name: 'maintenance',
    generationId: 'gen-1',
    fencingToken: 7,
    expiresAt: '2026-09-01T00:10:00.000Z',
    protocolVersion: 3,
    schemaVersion: 'v42',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

const applied = (runKey: string, deleted = 0): MaintenanceCommandReply => ({
  status: 'applied',
  jobKind: 'message-expiry',
  runKey,
  deleted,
})

it('reads a lease back exactly as written and reports a missing one as undefined, not null', async () => {
  const store = await openTestStore(':memory:')
  try {
    expect(store.maintenance.getLease('maintenance')).toBeUndefined()

    const row = lease()
    store.maintenance.putLease(row)
    expect(store.maintenance.getLease('maintenance')).toEqual(row)
    // Numeric columns come back as numbers, not strings: a conversion that lost
    // the column type would compare a fencing token against a string forever.
    expect(typeof store.maintenance.getLease('maintenance')?.fencingToken).toBe('number')
    expect(typeof store.maintenance.getLease('maintenance')?.protocolVersion).toBe('number')
  } finally {
    store.close()
  }
})

it('replaces every column of an existing lease and keeps other leases separate', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.maintenance.putLease(lease())
    store.maintenance.putLease(lease({ name: 'other', generationId: 'gen-other' }))

    const renewed = lease({
      generationId: 'gen-2',
      fencingToken: 8,
      expiresAt: '2026-09-01T00:20:00.000Z',
      protocolVersion: 4,
      schemaVersion: 'v43',
      updatedAt: '2026-09-01T00:10:00.000Z',
    })
    store.maintenance.putLease(renewed)

    expect(store.maintenance.getLease('maintenance')).toEqual(renewed)
    expect(store.maintenance.getLease('other')?.generationId).toBe('gen-other')
  } finally {
    store.close()
  }
})

it('recalls a recorded command by its job and run key, and nothing for either half alone', async () => {
  const store = await openTestStore(':memory:')
  try {
    expect(store.maintenance.getCommand('message-expiry', 'run-1')).toBeUndefined()

    const reply = applied('run-1', 12)
    store.maintenance.recordCommand(reply, 7, '2026-09-01T00:00:00.000Z')
    expect(store.maintenance.getCommand('message-expiry', 'run-1')).toEqual(reply)

    // The key is the PAIR. Neither half on its own reaches the row.
    expect(store.maintenance.getCommand('message-expiry', 'run-2')).toBeUndefined()
    expect(store.maintenance.getCommand('event-log-prune', 'run-1')).toBeUndefined()
  } finally {
    store.close()
  }
})

it('prunes strictly before the cutoff, at most a batch at a time, oldest first', async () => {
  const store = await openTestStore(':memory:')
  try {
    const at = (minute: number) => `2026-09-01T00:${String(minute).padStart(2, '0')}:00.000Z`
    for (let i = 0; i < 6; i++) {
      store.maintenance.recordCommand(applied(`run-${i}`), 7, at(i))
    }
    const cutoff = at(4)

    // BOTH EDGES of `<`: the row AT the cutoff survives, the one before it goes.
    // A conversion to `lte` would delete one row more than the caller asked for.
    expect(store.maintenance.pruneCommandsBatch(cutoff, 2)).toBe(2)
    expect(store.maintenance.getCommand('message-expiry', 'run-0')).toBeUndefined()
    expect(store.maintenance.getCommand('message-expiry', 'run-1')).toBeUndefined()
    // Oldest first: run-2 and run-3 are still here, so the batch took the head.
    expect(store.maintenance.getCommand('message-expiry', 'run-2')).toBeDefined()
    expect(store.maintenance.getCommand('message-expiry', 'run-3')).toBeDefined()

    expect(store.maintenance.pruneCommandsBatch(cutoff, 10)).toBe(2)
    expect(store.maintenance.getCommand('message-expiry', 'run-2')).toBeUndefined()
    expect(store.maintenance.getCommand('message-expiry', 'run-3')).toBeUndefined()
    // At the cutoff and after it: untouched, and a further prune finds nothing.
    expect(store.maintenance.getCommand('message-expiry', 'run-4')).toBeDefined()
    expect(store.maintenance.getCommand('message-expiry', 'run-5')).toBeDefined()
    expect(store.maintenance.pruneCommandsBatch(cutoff, 10)).toBe(0)
  } finally {
    store.close()
  }
})

it('refuses a batch size that is not a positive integer, before touching the database', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.maintenance.recordCommand(applied('run-1'), 7, '2026-09-01T00:00:00.000Z')
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => store.maintenance.pruneCommandsBatch('2026-09-02T00:00:00.000Z', bad)).toThrow(
        RangeError,
      )
    }
    // The guard is a refusal, not a no-op that deleted first.
    expect(store.maintenance.getCommand('message-expiry', 'run-1')).toBeDefined()
  } finally {
    store.close()
  }
})

it('throws rather than quarantining when a stored command reply is not a valid reply', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.maintenance.recordCommand(applied('run-1'), 7, '2026-09-01T00:00:00.000Z')
    // The same raw seam `store/json-column-corruption-oracle.test.ts` uses to
    // plant a corrupt value: there is no typed way to write an invalid reply,
    // which is the point — only a hand-edited database or an older writer can
    // produce one, and this pins what happens when one does.
    rawDb(store)
      .prepare('UPDATE maintenance_commands SET result_json = ? WHERE job_kind = ? AND run_key = ?')
      .run('{"status":"nonsense"}', 'message-expiry', 'run-1')
    expect(() => store.maintenance.getCommand('message-expiry', 'run-1')).toThrow()
  } finally {
    store.close()
  }
})
