/**
 * THE META AND SECRETS SPLIT (POD-6959 design 2.1, task POD-7013).
 *
 * `meta` and `server_secrets` each mixed install keys and workspace keys. The
 * migration `workspace-meta-split` creates `workspace_meta` and
 * `workspace_secrets`, moves the workspace keys into them under the one
 * workspace of a self-hosted install, `local`, and deletes them from the install
 * tables.
 *
 * The fixture is the real migration chain up to the split, with one row for
 * every key the manifest lists (`store/workspace-manifest.ts`; a key family gets
 * one member), a key this build does not know and a lookalike of each family.
 * Then the split runs through the real migrator, and the test checks:
 *
 *   - every workspace key is in the new table under 'local', with the value (and
 *     for a secret the rotation time) it had;
 *   - every install key, the unknown key and the lookalikes stay where they were,
 *     and nothing else is in the install tables;
 *   - every other table holds exactly the rows it held before.
 *
 * Seeding from the manifest's lists is what ties them to the migration's SQL,
 * which spells the same lists out because a migration is frozen history: a key
 * added to a list and not to the SQL (or the reverse) fails here.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  INSTALL_META_KEYS,
  INSTALL_SECRET_KEYS,
  type KeyPattern,
  WORKSPACE_META_KEYS,
  WORKSPACE_SECRET_KEYS,
} from '../store/workspace-manifest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const SPLIT = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_workspace-meta-split'))

/** One concrete key per pattern: the key itself, or one member of a family. */
const keysOf = (patterns: readonly KeyPattern[]): string[] =>
  patterns.map((p) => ('key' in p ? p.key : `${p.prefix}example`))

/** Keys no list names: they stay where they are. The lookalikes miss a family by one character. */
const UNLISTED_META = ['some.future.key', 'model_catalogX', 'setup_enrollment', 'data_migrationX:a']
const UNLISTED_SECRETS = ['some.future.secret', 'native-login-transfer']

const SECRET_UPDATED_AT = '2026-11-17T00:00:00.000Z'

const seededValue = (key: string): string => `value of ${key}`

type Row = Record<string, unknown>

const tablesOf = (db: SqlDatabase): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name)

/** Rows in one order whatever their columns: by their JSON text. */
const sorted = (rows: Row[]): Row[] =>
  rows
    .map((row) => [JSON.stringify(row), row] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row)

const rowsOf = (db: SqlDatabase, table: string): Row[] =>
  sorted(db.prepare(`SELECT * FROM "${table}"`).all() as Row[])

/** The four tables the split reads and writes; every other table must not change. */
const SPLIT_TABLES = new Set(['meta', 'server_secrets', 'workspace_meta', 'workspace_secrets'])

describe('meta and secrets split', () => {
  let db: SqlDatabase
  const before = new Map<string, Row[]>()
  let applied: readonly string[] = []

  beforeAll(() => {
    expect(SPLIT, 'the split migration is in the manifest').toBeGreaterThan(0)
    db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, SPLIT))
    expect(tablesOf(db)).not.toContain('workspace_meta')
    // A fresh chain may already hold some keys; the fixture owns both tables.
    db.exec('DELETE FROM meta; DELETE FROM server_secrets')
    const putMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    for (const key of [...keysOf(INSTALL_META_KEYS), ...keysOf(WORKSPACE_META_KEYS)])
      putMeta.run(key, seededValue(key))
    for (const key of UNLISTED_META) putMeta.run(key, seededValue(key))
    const putSecret = db.prepare(
      'INSERT INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?)',
    )
    for (const key of [...keysOf(INSTALL_SECRET_KEYS), ...keysOf(WORKSPACE_SECRET_KEYS)])
      putSecret.run(key, seededValue(key), SECRET_UPDATED_AT)
    for (const key of UNLISTED_SECRETS) putSecret.run(key, seededValue(key), SECRET_UPDATED_AT)
    for (const table of tablesOf(db)) {
      if (!SPLIT_TABLES.has(table) && table !== '__drizzle_migrations')
        before.set(table, rowsOf(db, table))
    }
    applied = runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, SPLIT + 1))
  })
  afterAll(() => db.close())

  it('runs the split alone, over a fixture with every listed key', () => {
    expect(applied).toEqual([DRIZZLE_MIGRATIONS[SPLIT]?.name])
    // Non-vacuous: the lists are the design's, not empty.
    expect(keysOf(WORKSPACE_META_KEYS)).toContain('settings')
    expect(keysOf(WORKSPACE_SECRET_KEYS)).toContain('notifications.telegramBotToken')
    expect(keysOf(WORKSPACE_SECRET_KEYS)).toContain('settings.fingerprintKey')
  })

  it("moves every workspace key of meta to workspace_meta under 'local', with its value", () => {
    expect(rowsOf(db, 'workspace_meta')).toEqual(
      sorted(
        keysOf(WORKSPACE_META_KEYS).map((key) => ({
          workspace_id: 'local',
          key,
          value: seededValue(key),
        })),
      ),
    )
  })

  it("moves every workspace secret to workspace_secrets under 'local', with its value and rotation time", () => {
    expect(rowsOf(db, 'workspace_secrets')).toEqual(
      sorted(
        keysOf(WORKSPACE_SECRET_KEYS).map((key) => ({
          workspace_id: 'local',
          key,
          value: seededValue(key),
          updated_at: SECRET_UPDATED_AT,
        })),
      ),
    )
  })

  it('keeps the install keys and the keys no list names in the install tables, and nothing else', () => {
    expect(rowsOf(db, 'meta')).toEqual(
      sorted(
        [...keysOf(INSTALL_META_KEYS), ...UNLISTED_META].map((key) => ({
          key,
          value: seededValue(key),
        })),
      ),
    )
    expect(rowsOf(db, 'server_secrets')).toEqual(
      sorted(
        [...keysOf(INSTALL_SECRET_KEYS), ...UNLISTED_SECRETS].map((key) => ({
          key,
          value: seededValue(key),
          updated_at: SECRET_UPDATED_AT,
        })),
      ),
    )
  })

  it('changes no other table', () => {
    expect(before.size).toBeGreaterThan(100)
    for (const [table, rows] of before) expect(rowsOf(db, table), table).toEqual(rows)
  })

  it('keys both new tables (workspace_id, key)', () => {
    for (const table of ['workspace_meta', 'workspace_secrets']) {
      const key = (
        db
          .prepare('SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
          .all(table) as { name: string }[]
      ).map((column) => column.name)
      expect(key, table).toEqual(['workspace_id', 'key'])
    }
  })
})
