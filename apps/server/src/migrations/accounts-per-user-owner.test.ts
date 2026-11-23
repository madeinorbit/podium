/**
 * MANAGED KEYS BECOME PER USER (POD-6360, user decision 2026-11-04).
 *
 * The upgrade records today's behaviour explicitly: every existing key was one
 * instance-wide row every user's agents used, so it becomes owned by the first
 * admin and shared with everyone. Nothing else about the row changes.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { expect, test } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const cut = DRIZZLE_MIGRATIONS.findIndex((migration) =>
  migration.name.includes('accounts-per-user-owner'),
)

function upgradedFrom(seed: (db: ReturnType<typeof openDatabase>) => void) {
  const db = openDatabase(':memory:')
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  seed(db)
  const before = db.prepare('SELECT * FROM accounts ORDER BY id').all()
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
  return { db, before }
}

const insertKey = (db: ReturnType<typeof openDatabase>, id: string, credential: string) =>
  db
    .prepare(
      "INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at) VALUES (?, 'anthropic', ?, ?, 'mask', 'role', 1)",
    )
    .run(id, id === 'managed:claude-oauth' ? 'oauth' : 'api-key', credential)

test('existing keys become the first admin’s, shared with everyone, otherwise unchanged', () => {
  const { db, before } = upgradedFrom((db) => {
    // A later admin and a disabled earlier admin: the earliest ACTIVE admin owns.
    db.exec(
      "INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES ('user:gone', 'Gone', 'admin', '2000-01-01', '2026-01-01')",
    )
    db.exec(
      "INSERT INTO users (id, display_name, role, created_at) VALUES ('user:later-admin', 'Later', 'admin', '2999-01-01')",
    )
    insertKey(db, 'managed:anthropic', 'sk-ant-old')
    insertKey(db, 'managed:claude-oauth', 'oat-old')
  })
  try {
    const firstAdmin = db
      .prepare(
        "SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at, id LIMIT 1",
      )
      .get() as { id: string }
    expect(firstAdmin.id).not.toBe('user:gone')
    expect(firstAdmin.id).not.toBe('user:later-admin')
    const after = db.prepare('SELECT * FROM accounts ORDER BY id').all()
    expect(after).toEqual(
      before.map((row) => ({
        ...(row as { id: string }),
        owner_user_id: firstAdmin.id,
        account_key: (row as { id: string }).id,
        shared_with: '["*"]',
      })),
    )
    // One row per (owner, account id) from here on.
    expect(() =>
      db
        .prepare(
          "INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at, owner_user_id, account_key) VALUES ('dup', 'anthropic', 'api-key', 'x', '', 'role', 2, ?, 'managed:anthropic')",
        )
        .run(firstAdmin.id),
    ).toThrow()
  } finally {
    db.close()
  }
})

test('a store with no active admin leaves its keys ownerless (never injected)', () => {
  const { db } = upgradedFrom((db) => {
    db.exec("UPDATE users SET disabled_at = '2026-01-01' WHERE role = 'admin'")
    insertKey(db, 'managed:anthropic', 'sk-ant-old')
  })
  try {
    expect(db.prepare('SELECT owner_user_id, account_key, shared_with FROM accounts').all()).toEqual(
      [{ owner_user_id: null, account_key: 'managed:anthropic', shared_with: '["*"]' }],
    )
  } finally {
    db.close()
  }
})
