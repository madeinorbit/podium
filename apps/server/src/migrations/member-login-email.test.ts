import { openDatabase } from '@podium/runtime/sqlite'
import { expect, test } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

test('email upgrade preserves members and credentials, permits nulls, and enforces uniqueness in SQLite', () => {
  const db = openDatabase(':memory:')
  try {
    const cut = DRIZZLE_MIGRATIONS.findIndex((migration) =>
      migration.name.includes('member-login-email'),
    )
    expect(cut).toBeGreaterThan(0)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
    const before = db.prepare('SELECT * FROM users').all()
    expect(before.length).toBeGreaterThan(0)
    const first = before[0] as { id: string }
    db.prepare(
      "INSERT INTO user_credentials (user_id, source, password_hash, updated_at) VALUES (?, 'per-user-scrypt', 'existing-hash', '2026-09-11')",
    ).run(first.id)
    const credentials = db.prepare('SELECT * FROM user_credentials').all()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    expect(db.prepare('SELECT * FROM users').all()).toEqual(
      before.map((row) => ({ ...(row as object), email: null })),
    )
    expect(db.prepare('SELECT * FROM user_credentials').all()).toEqual(credentials)
    db.exec(
      "INSERT INTO users (id, display_name, role, created_at) VALUES ('other', 'Other', 'member', '2026-09-11')",
    )
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run('alice@example.com', first.id)
    expect(() =>
      db.exec("UPDATE users SET email = 'ALICE@example.com' WHERE id = 'other'"),
    ).toThrow()
  } finally {
    db.close()
  }
})
