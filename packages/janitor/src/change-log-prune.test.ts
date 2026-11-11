import { readdirSync, readFileSync } from 'node:fs'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { ChangeLogPrunePlanner } from './janitor'

const input = { keepRows: 3, maxAgeMs: 1_000, batchSize: 2, nowMs: 2_000 }

function database(): SqlDatabase {
  const db = openDatabase(':memory:')
  db.exec(`
    CREATE TABLE sync_feed (tenant_id TEXT PRIMARY KEY, head_seq INTEGER NOT NULL, floor_seq INTEGER NOT NULL);
    CREATE TABLE changes (
      tenant_id TEXT NOT NULL, seq INTEGER NOT NULL, event_time INTEGER NOT NULL, payload TEXT,
      PRIMARY KEY (tenant_id, seq)
    );
    CREATE INDEX changes_event_time ON changes (tenant_id, event_time);
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
  it('keeps another tenant’s high head and old rows out of the local plan', async () => {
    const db = database()
    try {
      seed(db, 'local', 12, 8, 8)
      seed(db, 'busy', 1_008, 1_001, 1_008)
      expect(await new ChangeLogPrunePlanner(db).plan(input)).toEqual([
        { keepRows: 3, maxAgeMs: 1_000, batchSize: 2, thresholdSeq: 9, fromSeq: 8 },
      ])
      const busy = await new ChangeLogPrunePlanner(db, 'busy').plan(input)
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
      db.prepare('UPDATE changes SET event_time = ? WHERE tenant_id = ? AND seq = ?').run(
        999,
        'local',
        9,
      )
      // Equal to the cutoff is retained: age is strictly less than the cutoff.
      db.prepare('UPDATE changes SET event_time = ? WHERE tenant_id = ? AND seq = ?').run(
        1_000,
        'local',
        12,
      )
      expect(await new ChangeLogPrunePlanner(db).plan({ ...input, keepRows: 100 })).toEqual([
        { keepRows: 100, maxAgeMs: 1_000, batchSize: 2, thresholdSeq: 9, fromSeq: 8 },
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
      expect(await new ChangeLogPrunePlanner(db).plan(input)).toEqual([])
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
      db.exec("DELETE FROM changes WHERE tenant_id = 'local' AND seq <= 200")
      db.exec("UPDATE sync_feed SET floor_seq = 201 WHERE tenant_id = 'local'")
      const second = await planner.plan({ ...input, keepRows: 0 })
      expect(second).toHaveLength(25)
      expect(second[0]?.fromSeq).toBe(201)
      db.exec("DELETE FROM changes WHERE tenant_id = 'local'")
      db.exec("UPDATE sync_feed SET floor_seq = 251 WHERE tenant_id = 'local'")
      expect(await planner.plan({ ...input, keepRows: 0 })).toEqual([])
    } finally {
      db.close()
    }
  })

  it('adds a covering age index without changing rows and seeks both planner reads', async () => {
    const db = database()
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
      const prepare = vi.spyOn(db, 'prepare')
      const planner = new ChangeLogPrunePlanner(db)
      await planner.plan(input)
      await planner.plan(input)
      const queries = prepare.mock.calls.map(([query]) => query)
      prepare.mockRestore()
      // Both statements are prepared once, independent of ticks and batch count.
      expect(queries).toHaveLength(2)
      const plans = queries.map(
        (query) =>
          db
            .prepare(`EXPLAIN QUERY PLAN ${query}`)
            .all(...(query.includes('sync_feed') ? ['local'] : ['local', 1_000])) as {
            detail: string
          }[],
      )
      expect(plans.flat().every((row) => row.detail.startsWith('SEARCH '))).toBe(true)
      expect(
        plans
          .flat()
          .map((row) => row.detail)
          .join('\n'),
      ).toContain('USING COVERING INDEX changes_event_time (tenant_id=? AND event_time<?)')
    } finally {
      db.close()
    }
  })
})
