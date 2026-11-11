import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const cut = DRIZZLE_MIGRATIONS.findIndex((migration) => migration.name.endsWith('_sync-log-only'))

describe('sync log without the copy table', () => {
  it('drops the copy and its index, preserving model rows, log, identity and generations', () => {
    const db = openDatabase(':memory:')
    try {
      expect(cut).toBeGreaterThan(0)
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
      db.exec("INSERT INTO change_latest VALUES ('conversation', 'c', 1, '{}')")
      db.exec(
        "INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES ('conversation', 'c', 'upsert', '{}', 1)",
      )
      const before = ['changes', 'feed_identity', 'sync_kind', 'users'].map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      )
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('change_latest', 'change_latest_seq')",
          )
          .all(),
      ).toEqual([])
      const after = ['changes', 'feed_identity', 'sync_kind', 'users'].map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      )
      expect(after).toEqual(before)
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
      expect(db.prepare('SELECT seq FROM changes').all()).toEqual([{ seq: 1 }])
    } finally {
      db.close()
    }
  })
})
