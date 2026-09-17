import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const retired = 'user:sole'
const mappingIndex = () => DRIZZLE_MIGRATIONS.findIndex((migration) => migration.name.includes('record-retired-member-mapping'))

function beforeMapping(): SqlDatabase {
  const db = openDatabase(':memory:')
  const index = mappingIndex()
  expect(index).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, index))
  db.prepare('INSERT INTO podium_events (ts, kind, subject, payload) VALUES (?, ?, ?, ?)').run('now', 'audit', 'subject', JSON.stringify({ attribution: { actor: { id: retired }, onBehalfOf: retired }, ownerUserId: retired }))
  db.prepare('INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)').run('userLayout', retired, 'upsert', JSON.stringify({ ownerUserId: retired }), 1)
  db.prepare('INSERT INTO change_latest (entity, entity_id, seq, payload) VALUES (?, ?, ?, ?)').run('userLayout', retired, 1, JSON.stringify({ ownerUserId: retired }))
  return db
}

describe('retired member mapping migration', () => {
  it('records the minted member and rewrites discovered historical carriers', () => {
    const db = beforeMapping()
    try {
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      const member = (db.prepare('SELECT id FROM users').get() as { id: string }).id
      expect(db.prepare('SELECT value FROM meta WHERE key = ?').get('retired_solo_member_id')).toEqual({ value: member })
      expect(db.prepare('SELECT payload FROM podium_events WHERE id = 1').get()).toEqual({ payload: JSON.stringify({ attribution: { actor: { id: member }, onBehalfOf: member }, ownerUserId: member }) })
      expect(db.prepare('SELECT entity_id FROM changes').get()).toEqual({ entity_id: member })
      expect(db.prepare('SELECT entity_id FROM change_latest').get()).toEqual({ entity_id: member })
    } finally {
      db.close()
    }
  })
})
