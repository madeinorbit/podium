import { readdirSync, readFileSync } from 'node:fs'
import { changeLogPruneRunKey } from '@podium/protocol'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { ChangeLogPrunePlanner } from './janitor'

const input = { keepRows: 3, maxAgeMs: 1_000, batchSize: 2, nowMs: 2_000 }

/** The feed tables before the covering index; `tenant_id` is the shape before POD-7012's rename. */
function database(workspace: 'workspace_id' | 'tenant_id' = 'workspace_id'): SqlDatabase {
  const db = openDatabase(':memory:')
  db.exec(`
    CREATE TABLE sync_feed (${workspace} TEXT PRIMARY KEY, head_seq INTEGER NOT NULL, floor_seq INTEGER NOT NULL);
    CREATE TABLE changes (
      ${workspace} TEXT NOT NULL, seq INTEGER NOT NULL, event_time INTEGER NOT NULL, payload TEXT,
      PRIMARY KEY (${workspace}, seq)
    );
    CREATE INDEX changes_event_time ON changes (${workspace}, event_time);
  `)
  return db
}

function seed(db: SqlDatabase, tenant: string, head: number, floor: number, agedThrough = 0): void {
  db.prepare('INSERT INTO sync_feed VALUES (?, ?, ?)').run(tenant, head, floor)
  const insert = db.prepare('INSERT INTO changes VALUES (?, ?, ?, ?)')
  for (let seq = floor; seq <= head; seq++) {
    insert.run(tenant, seq, seq <= agedThrough ? 999 : 1_999, '{}')
  }
}

describe('ChangeLogPrunePlanner tenant bounds', () => {
  it('plans every tenant with its own head, floor and age threshold', async () => {
    const db = database()
    try {
      seed(db, 'local', 12, 8, 8)
      seed(db, 'busy', 1_008, 1_001, 1_008)
      const batches = await new ChangeLogPrunePlanner(db).plan(input)
      expect(batches.filter((batch) => batch.tenantId === 'local')).toEqual([
        {
          tenantId: 'local',
          keepRows: 3,
          maxAgeMs: 1_000,
          batchSize: 2,
          thresholdSeq: 9,
          fromSeq: 8,
        },
      ])
      const busy = batches.filter((batch) => batch.tenantId === 'busy')
      expect(busy.map((batch) => batch.fromSeq)).toEqual([1_001, 1_003, 1_005, 1_007])
      expect(busy.every((batch) => batch.thresholdSeq === 1_008)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('uses the highest aged sequence even when event times are out of order', async () => {
    const db = database()
    try {
      seed(db, 'local', 12, 8)
      db.prepare('UPDATE changes SET event_time = ? WHERE workspace_id = ? AND seq = ?').run(
        999,
        'local',
        9,
      )
      // Equal to the cutoff is retained: age is strictly less than the cutoff.
      db.prepare('UPDATE changes SET event_time = ? WHERE workspace_id = ? AND seq = ?').run(
        1_000,
        'local',
        12,
      )
      expect(await new ChangeLogPrunePlanner(db).plan({ ...input, keepRows: 100 })).toEqual([
        {
          tenantId: 'local',
          keepRows: 100,
          maxAgeMs: 1_000,
          batchSize: 2,
          thresholdSeq: 9,
          fromSeq: 8,
        },
      ])
    } finally {
      db.close()
    }
  })

  it.each(['missing', 'empty', 'retained'])('emits no work for a %s tenant feed', async (state) => {
    const db = database()
    try {
      seed(db, 'busy', 1_008, 1_001, 1_008)
      if (state === 'empty') seed(db, 'local', 12, 13)
      if (state === 'retained') seed(db, 'local', 12, 11)
      const batches = await new ChangeLogPrunePlanner(db).plan(input)
      expect(batches).toHaveLength(4)
      expect(batches.every((batch) => batch.tenantId === 'busy')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('keeps replay keys distinct for tenants with identical sequence bounds', async () => {
    const db = database()
    try {
      seed(db, 'one/tenant', 5, 1, 5)
      seed(db, 'two', 5, 1, 5)
      const batches = await new ChangeLogPrunePlanner(db).plan(input)
      expect(batches).toHaveLength(6)
      expect(new Set(batches.map(changeLogPruneRunKey)).size).toBe(6)
    } finally {
      db.close()
    }
  })

  it('pages tenant metadata beyond one page without dropping a tenant', async () => {
    const db = database()
    try {
      for (let i = 0; i < 30; i++) seed(db, `tenant-${i}`, 1, 1, 1)
      const batches = await new ChangeLogPrunePlanner(db).plan(input)
      expect(batches).toHaveLength(30)
      expect(new Set(batches.map((batch) => batch.tenantId)).size).toBe(30)
    } finally {
      db.close()
    }
  })

  it('caps planning at 100 batches and resumes from the durable floor', async () => {
    const db = database()
    try {
      seed(db, 'local', 250, 1, 250)
      const planner = new ChangeLogPrunePlanner(db)
      const first = await planner.plan({ ...input, keepRows: 0 })
      expect(first).toHaveLength(100)
      expect(first[99]?.fromSeq).toBe(199)
      db.exec("DELETE FROM changes WHERE workspace_id = 'local' AND seq <= 200")
      db.exec("UPDATE sync_feed SET floor_seq = 201 WHERE workspace_id = 'local'")
      const second = await planner.plan({ ...input, keepRows: 0 })
      expect(second).toHaveLength(25)
      expect(second[0]?.fromSeq).toBe(201)
      db.exec("DELETE FROM changes WHERE workspace_id = 'local'")
      db.exec("UPDATE sync_feed SET floor_seq = 251 WHERE workspace_id = 'local'")
      expect(await planner.plan({ ...input, keepRows: 0 })).toEqual([])
    } finally {
      db.close()
    }
  })

  it('adds a covering age index without changing rows and seeks both planner reads', async () => {
    const db = database('tenant_id')
    try {
      seed(db, 'local', 12, 8, 8)
      const migrationRoot = new URL('../../../apps/server/src/migrations/drizzle/', import.meta.url)
      const migration = readdirSync(migrationRoot).find((name) =>
        name.endsWith('_changes-event-time-covering'),
      )
      expect(migration, 'cover the tenant age range in a new additive migration').toBeDefined()
      db.exec(readFileSync(new URL(`${migration}/migration.sql`, migrationRoot), 'utf8'))
      expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 5 })
      expect(db.prepare('SELECT * FROM sync_feed').get()).toEqual({
        tenant_id: 'local',
        head_seq: 12,
        floor_seq: 8,
      })
      expect(
        db
          .prepare('PRAGMA index_info(changes_event_time)')
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(['tenant_id', 'event_time', 'seq'])
      // The workspace column migration (POD-7012) renames the column in place; the index follows.
      db.exec('ALTER TABLE changes RENAME COLUMN tenant_id TO workspace_id')
      db.exec('ALTER TABLE sync_feed RENAME COLUMN tenant_id TO workspace_id')
      const prepare = vi.spyOn(db, 'prepare')
      const planner = new ChangeLogPrunePlanner(db)
      await planner.plan(input)
      await planner.plan(input)
      const queries = prepare.mock.calls.map(([query]) => query)
      prepare.mockRestore()
      // One paged statement is prepared once, independent of ticks and tenant count.
      expect(queries).toHaveLength(1)
      const plans = db.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all(1_000, '', 25) as {
        detail: string
      }[]
      expect(plans.some((row) => /\bSCAN\b/.test(row.detail))).toBe(false)
      expect(plans.some((row) => /SEARCH feed USING INDEX/.test(row.detail))).toBe(true)
      expect(plans.map((row) => row.detail).join('\n')).toContain(
        'USING COVERING INDEX changes_event_time (workspace_id=? AND event_time<?)',
      )
    } finally {
      db.close()
    }
  })
})
