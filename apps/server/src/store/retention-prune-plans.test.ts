/**
 * THE RETENTION DELETES READ ONLY WHAT THEY DELETE (POD-7035, audit findings 4 and 5).
 *
 * `pruneCommandsBatch` sorted the whole maintenance ledger for every batch (`SCAN
 * maintenance_commands | USE TEMP B-TREE FOR ORDER BY`: 216k rows, 627 ms a call,
 * on every janitor tick). The receipt prune deleted every receipt past the
 * horizon in one statement at boot. Each now reads its batch off the front of
 * an index, which the plan of the statement the store really runs shows.
 */

import { asMutationId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { probeStatements, type StatementProbeHolder } from './executor'

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<{ store: SessionStore; db: SqlDatabase }> {
  store = await openTestStore(':memory:')
  return { store, db: (store as unknown as { db: SqlDatabase }).db }
}

/** The plans of the statements `run` makes against `table`. */
async function plansOf(
  s: SessionStore,
  db: SqlDatabase,
  table: string,
  run: () => Promise<unknown>,
): Promise<string[]> {
  const statements: string[] = []
  const detach = probeStatements(s as unknown as StatementProbeHolder, (observation) => {
    if (observation.sql.includes(table)) statements.push(observation.sql)
  })
  try {
    await run()
  } finally {
    detach()
  }
  return statements.map((statement) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as { detail: string }[])
      .map((row) => row.detail)
      .join(' | '),
  )
}

describe('the maintenance receipt prune (POD-7035)', () => {
  it('reads its batch off idx_maintenance_commands_applied_at, with no sort', async () => {
    const { store: s, db } = await open()
    const plans = await plansOf(s, db, 'maintenance_commands', async () =>
      s.maintenance.pruneCommandsBatch('2026-01-01T00:00:00.000Z', 500),
    )
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      expect(plan).toContain('idx_maintenance_commands_applied_at')
      expect(plan).not.toContain('TEMP B-TREE')
      expect(plan).not.toMatch(/SCAN maintenance_commands(?! USING COVERING INDEX)/)
    }
  })

  it('deletes the oldest receipts first, in (applied_at, job_kind, run_key) order', async () => {
    const { store: s, db } = await open()
    const record = async (runKey: string, appliedAt: string) =>
      await s.maintenance.recordCommand(
        { status: 'applied', jobKind: 'connect-scan', runKey },
        1,
        appliedAt,
      )
    await record('b', '2026-01-01T00:00:00.000Z')
    await record('a', '2026-01-01T00:00:00.000Z')
    await record('c', '2025-12-31T00:00:00.000Z')
    await record('young', '2026-03-01T00:00:00.000Z')
    expect(await s.maintenance.pruneCommandsBatch('2026-02-01T00:00:00.000Z', 2)).toBe(2)
    expect(
      (
        db.prepare('SELECT run_key FROM maintenance_commands ORDER BY run_key').all() as {
          run_key: string
        }[]
      ).map((row) => row.run_key),
    ).toEqual(['b', 'young'])
  })
})

describe('the mutation receipt prune (POD-7035)', () => {
  it('deletes one batch through idx_applied_mutations_applied_at, reading no result payload', async () => {
    const { store: s, db } = await open()
    for (let i = 0; i < 5; i += 1) {
      await s.sync.recordAppliedMutation(asMutationId(`m${i}`), 'p', '"x"', 100 + i)
    }
    let deleted = 0
    const plans = await plansOf(s, db, 'applied_mutations', async () => {
      deleted = await s.sync.pruneAppliedMutationsBatch(1_000, 3)
    })
    expect(deleted).toBe(3)
    for (const plan of plans) {
      expect(plan).toContain('idx_applied_mutations_applied_at')
      expect(plan).not.toMatch(/SCAN applied_mutations(?! USING COVERING INDEX)/)
    }
  })

  it('no longer runs on the boot path', async () => {
    const { store: s } = await open()
    // A receipt far past any horizon survives a boot of the session registry:
    // the janitor prunes it, in batches, while the server runs.
    await s.sync.recordAppliedMutation(asMutationId('ancient'), 'p', '"x"', 1)
    const { SessionRegistry } = await import('../relay')
    const registry = await SessionRegistry.create(s, undefined, { instanceId: 'default' })
    try {
      expect(await s.sync.getAppliedMutation(asMutationId('ancient'))).toBe('"x"')
    } finally {
      await registry.dispose()
    }
  })
})
