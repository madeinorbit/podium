import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const cut = DRIZZLE_MIGRATIONS.findIndex((migration) =>
  migration.name.includes('personal-provider-keys'),
)
const copies: string[] = []
afterEach(() => {
  for (const directory of copies.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(personal?: string) {
  expect(cut).toBeGreaterThan(0)
  const directory = mkdtempSync(join(tmpdir(), 'podium-provider-key-upgrade-'))
  copies.push(directory)
  const before = join(directory, 'before.sqlite')
  const upgraded = join(directory, 'upgraded.sqlite')
  const db = openDatabase(before)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  // The first active admin is deliberately not the first admin in the table.
  db.exec("UPDATE users SET disabled_at = '2026-01-01' WHERE role = 'admin'")
  db.exec(
    "INSERT INTO users (id, display_name, role, created_at) VALUES ('mem_first', 'First', 'admin', '2026-01-02'), ('mem_later', 'Later', 'admin', '2026-01-03')",
  )
  db.exec(
    "INSERT INTO server_secrets (key, value, updated_at) VALUES ('apiKeys.anthropic', 'old-workspace-key', '2026-01-01'), ('notifications.telegramBotToken', 'telegram-token', '2026-01-01')",
  )
  if (personal)
    db.prepare(
      "INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at, owner_user_id, account_key, ref, shared_with) VALUES ('personal', 'anthropic', 'api-key', ?, 'masked', 'role', 1, 'mem_first', 'managed:anthropic', 'managed:anthropic', NULL)",
    ).run(personal)
  // Rehearse an upgrade of an existing database copy, preserving the original.
  // Closing first checkpoints SQLite's WAL before the file is copied.
  db.close()
  copyFileSync(before, upgraded)
  return openDatabase(upgraded)
}

const rows = (db: ReturnType<typeof openDatabase>) =>
  db
    .prepare(
      'SELECT owner_user_id, account_key, credential, shared_with FROM accounts ORDER BY account_key',
    )
    .all()

function adopt(db: ReturnType<typeof openDatabase>) {
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
  expect(
    db.prepare("SELECT value FROM server_secrets WHERE key = 'apiKeys.anthropic'").get(),
  ).toBeUndefined()
  expect(
    db
      .prepare("SELECT value FROM server_secrets WHERE key = 'notifications.telegramBotToken'")
      .get(),
  ).toEqual({ value: 'telegram-token' })
  const first = rows(db)
  // Replay SQL, not just the name-keyed ledger, to prove idempotence.
  db.exec(DRIZZLE_MIGRATIONS[cut]!.sql)
  expect(rows(db)).toEqual(first)
}

describe('workspace provider keys become personal managed accounts', () => {
  it('adopts a key for the earliest active admin and shares it with everyone', () => {
    const db = fixture()
    try {
      adopt(db)
      expect(rows(db)).toEqual([
        {
          owner_user_id: 'mem_first',
          account_key: 'managed:anthropic',
          credential: 'old-workspace-key',
          shared_with: '["*"]',
        },
      ])
    } finally {
      db.close()
    }
  })
  it('deduplicates an equal personal key and makes its sharing explicit', () => {
    const db = fixture('old-workspace-key')
    try {
      adopt(db)
      expect(rows(db)).toEqual([
        {
          owner_user_id: 'mem_first',
          account_key: 'managed:anthropic',
          credential: 'old-workspace-key',
          shared_with: '["*"]',
        },
      ])
      expect(db.prepare('SELECT id, identity, created_at FROM accounts').get()).toEqual({
        id: 'personal',
        identity: 'masked',
        created_at: 1,
      })
    } finally {
      db.close()
    }
  })
  it('preserves a different personal key and its privacy, adopting the workspace key separately', () => {
    const db = fixture('private-personal-key')
    try {
      adopt(db)
      expect(rows(db)).toEqual([
        {
          owner_user_id: 'mem_first',
          account_key: 'managed:anthropic',
          credential: 'private-personal-key',
          shared_with: null,
        },
        {
          owner_user_id: 'mem_first',
          account_key: 'managed:anthropic:earlier-workspace',
          credential: 'old-workspace-key',
          shared_with: '["*"]',
        },
      ])
    } finally {
      db.close()
    }
  })
})
