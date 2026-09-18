import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const retired = 'user:sole'
const mappingIndex = () =>
  DRIZZLE_MIGRATIONS.findIndex((migration) =>
    migration.name.includes('record-retired-member-mapping'),
  )

function beforeMapping(): SqlDatabase {
  const db = openDatabase(':memory:')
  const index = mappingIndex()
  expect(index).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, index))
  db.prepare('INSERT INTO podium_events (ts, kind, subject, payload) VALUES (?, ?, ?, ?)').run(
    'now',
    'audit',
    'subject',
    JSON.stringify({
      attribution: { actor: { id: retired }, onBehalfOf: retired },
      ownerUserId: retired,
    }),
  )
  db.prepare(
    'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)',
  ).run('userLayout', retired, 'upsert', JSON.stringify({ ownerUserId: retired }), 1)
  db.prepare('INSERT INTO change_latest (entity, entity_id, seq, payload) VALUES (?, ?, ?, ?)').run(
    'userLayout',
    retired,
    1,
    JSON.stringify({ ownerUserId: retired }),
  )
  return db
}

describe('retired member mapping migration', () => {
  it('records the minted member and rewrites discovered historical carriers', () => {
    const db = beforeMapping()
    try {
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      const member = (db.prepare('SELECT id FROM users').get() as { id: string }).id
      expect(
        db.prepare('SELECT value FROM meta WHERE key = ?').get('retired_solo_member_id'),
      ).toEqual({ value: member })
      expect(db.prepare('SELECT payload FROM podium_events WHERE id = 1').get()).toEqual({
        payload: JSON.stringify({
          attribution: { actor: { id: member }, onBehalfOf: member },
          ownerUserId: member,
        }),
      })
      expect(db.prepare('SELECT entity_id FROM changes').get()).toEqual({ entity_id: member })
      expect(db.prepare('SELECT entity_id FROM change_latest').get()).toEqual({ entity_id: member })
    } finally {
      db.close()
    }
  })
})

describe('retired mapping provenance without boot refusal', () => {
  function secondMember(db: SqlDatabase) {
    db.prepare(
      "INSERT INTO users (id, display_name, role, created_at) VALUES ('mem_second', 'Second', 'admin', '2000-01-01')",
    ).run()
  }

  it('applies the pending mapping migration without guessing a member', () => {
    const db = beforeMapping()
    try {
      secondMember(db)
      const before = db.prepare('SELECT * FROM __drizzle_migrations').all()
      expect(() => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).not.toThrow()
      expect(db.prepare('SELECT * FROM __drizzle_migrations').all().length).toBeGreaterThan(before.length)
      expect(db.prepare("SELECT * FROM meta WHERE key = 'retired_solo_member_id'").all()).toEqual(
        [],
      )
    } finally {
      db.close()
    }
  })

  it('boots without inferring provenance when an earlier build already recorded the no-op', () => {
    const db = beforeMapping()
    try {
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      secondMember(db)
      db.prepare("DELETE FROM meta WHERE key = 'retired_solo_member_id'").run()
      expect(() => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).not.toThrow()
      expect(db.prepare("SELECT * FROM meta WHERE key = 'retired_solo_member_id'").all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('records the only member regardless of role, email, or disabled state', () => {
    const db = beforeMapping()
    try {
      db.prepare(
        "UPDATE users SET role = 'member', email = 'sole@example.com', disabled_at = '2026-09-18'",
      ).run()
      const member = (db.prepare('SELECT id FROM users').get() as { id: string }).id
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      expect(
        db.prepare("SELECT value FROM meta WHERE key = 'retired_solo_member_id'").get(),
      ).toEqual({ value: member })
    } finally {
      db.close()
    }
  })

  it('preserves recorded provenance with a disabled original member and another admin', () => {
    const db = beforeMapping()
    try {
      const member = (db.prepare('SELECT id FROM users').get() as { id: string }).id
      db.prepare("INSERT INTO meta (key, value) VALUES ('retired_solo_member_id', ?)").run(member)
      db.prepare("UPDATE users SET disabled_at = '2026-09-18'").run()
      secondMember(db)
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      expect(
        db.prepare("SELECT value FROM meta WHERE key = 'retired_solo_member_id'").get(),
      ).toEqual({ value: member })
    } finally {
      db.close()
    }
  })
})
