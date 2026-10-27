import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const index = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_first-flights-seen-state'))
const through = DRIZZLE_MIGRATIONS.slice(0, index + 1)
const migrationName = DRIZZLE_MIGRATIONS[index]?.name
if (!migrationName) throw new Error('First Flights migration is missing')

it('logs all seven moments for every account present at upgrade, preserves rows, and leaves new accounts eligible', () => {
  expect(index).toBeGreaterThan(0)
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, index))
    const add = db.prepare(
      'INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)',
    )
    add.run('existing', 'Existing', 'member', '2026-10-26T00:00:00Z')
    // Even an account created months after development but before upgrade is seeded.
    add.run('recent', 'Recent', 'member', '2027-02-01T00:00:00Z')
    db.prepare('INSERT INTO user_layout (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(
      'existing',
      'tips.seen.first-prompt',
      JSON.stringify('2026-10-26T01:00:00Z'),
      '2026-10-26T01:00:00Z',
    )
    db.prepare('INSERT INTO user_layout (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(
      'existing',
      'tips.enabled',
      JSON.stringify('false'),
      '2026-10-26T01:00:00Z',
    )
    runDrizzleMigrations(db, through)
    const rows = (id: string) =>
      db.prepare('SELECT key, value FROM user_layout WHERE user_id = ?').all(id) as {
        key: string
        value: string
      }[]
    expect(rows('existing')).toHaveLength(8)
    expect(
      JSON.parse(rows('existing').find((r) => r.key === 'tips.seen.first-prompt')?.value ?? 'null'),
    ).toBe('2026-10-26T01:00:00Z')
    expect(
      JSON.parse(rows('existing').find((r) => r.key === 'tips.enabled')?.value ?? 'null'),
    ).toBe('false')
    expect(rows('existing').filter((r) => r.key.startsWith('tips.seen.'))).toHaveLength(7)
    expect(rows('recent')).toHaveLength(7)
    for (const row of rows('recent')) {
      const time = JSON.parse(row.value)
      expect(new Date(time).toISOString()).toBe(time)
    }
    // New member on this established server, even after subsequent boots.
    add.run('later', 'Later', 'member', '2027-02-02T00:00:00Z')
    runDrizzleMigrations(db, through)
    expect(rows('later')).toEqual([])
  } finally {
    db.close()
  }
})

it('a fresh install leaves its generated first admin eligible', () => {
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, through)
    // The historical first-admin migration creates an account during the batch.
    expect(db.prepare('SELECT id FROM users').all()).toHaveLength(1)
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toEqual([])
    runDrizzleMigrations(db, through)
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toEqual([])
  } finally {
    db.close()
  }
})

it('commits the seen-state backfill and its receipt together', () => {
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, index))
    const broken = [
      ...through,
      { name: '20990101000000_failed-upgrade', sql: 'INSERT INTO missing_table VALUES (1)' },
    ]
    expect(() => runDrizzleMigrations(db, broken)).toThrow()
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toEqual([])
    expect(
      db.prepare('SELECT * FROM __drizzle_migrations WHERE name = ?').all(migrationName),
    ).toEqual([])
    runDrizzleMigrations(db, through)
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toHaveLength(
      7,
    )
  } finally {
    db.close()
  }
})
