import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

it('removes retired replication payloads, preserves current rows, and invalidates the old cursor', () => {
  const cut = DRIZZLE_MIGRATIONS.findIndex(m => m.name.endsWith('_record-question-attribution'))
  expect(cut).toBeGreaterThan(0)
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
    db.prepare('INSERT INTO feed_identity (singleton, feed_id, epoch) VALUES (1, ?, ?)').run('f', 'before')
    for (const entity of ['issueProjection', 'issueUserState', 'issueGitState', 'session', 'issue']) {
      const payload = JSON.stringify({ id: 'same-id', marker: entity })
      db.prepare('INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)')
        .run(entity, 'same-id', 'upsert', payload, 1)
      const seq = (db.prepare('SELECT MAX(seq) AS seq FROM changes').get() as { seq: number }).seq
      db.prepare('INSERT INTO change_latest (entity, entity_id, seq, payload) VALUES (?, ?, ?, ?)')
        .run(entity, 'same-id', seq, payload)
    }
    const before = db.prepare('SELECT * FROM changes ORDER BY seq').all() as { entity: string }[]
    const worldBefore = db.prepare('SELECT * FROM change_latest ORDER BY seq').all() as { entity: string }[]
    expect(before.filter(row => row.entity === 'issue')).toHaveLength(1)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    expect(db.prepare('SELECT * FROM changes ORDER BY seq').all()).toEqual(before.filter(row => row.entity !== 'issue'))
    expect(db.prepare('SELECT * FROM change_latest ORDER BY seq').all()).toEqual(worldBefore.filter(row => row.entity !== 'issue'))
    const identity = db.prepare('SELECT feed_id, epoch FROM feed_identity').get() as { feed_id: string; epoch: string }
    expect(identity.feed_id).toBe('f')
    expect(identity.epoch).not.toBe('before')
    expect((db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map(row => row.name)).toContain('human_question_attribution')
  } finally {
    db.close()
  }
})
