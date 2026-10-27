import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const index = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_first-flights-seen-state'))
const through = DRIZZLE_MIGRATIONS.slice(0, index + 1)

it('logs all seven moments for pre-rollout accounts, preserves rows, and leaves new accounts eligible', () => {
  expect(index).toBeGreaterThan(0)
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, index))
    const add = db.prepare(
      'INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)',
    )
    add.run('existing', 'Existing', 'member', '2026-10-26T00:00:00Z')
    add.run('new', 'New', 'member', '2026-10-27T17:00:00Z')
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
    expect(rows('new')).toEqual([])
    // New member on this established server, even after subsequent boots.
    add.run('later', 'Later', 'member', '2026-10-28T00:00:00Z')
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
    expect(db.prepare("SELECT * FROM user_layout WHERE key LIKE 'tips.seen.%'").all()).toEqual([])
  } finally {
    db.close()
  }
})
