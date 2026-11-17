/**
 * THE WORKSPACE COLUMN MIGRATION (POD-6959 design 2.6 "U3", migration M1, task
 * POD-7012).
 *
 * M1 gives every workspace table `workspace_id` with `DEFAULT 'local'` and renames
 * the sync tables' `tenant_id` to `workspace_id`. Both are metadata changes, which
 * is the whole point of splitting the upgrade in two: no row is rewritten, so an
 * install with gigabytes of history upgrades in milliseconds, and the table
 * rebuild that changes the keys (M2, POD-7024) comes later.
 *
 * The fixture is the real migration chain up to the migration before M1, with
 * two rows in every workspace table that accepts a generic row (values chosen
 * per column from its type and its CHECK constraints, foreign keys off). The
 * tables whose triggers refuse such a row stay empty, and the test says which.
 * Then M1 runs through the real migrator, and the test checks:
 *
 *   - every row of every workspace table reads workspace_id = 'local';
 *   - every table holds the same rows as before, the new column aside, and the
 *     sync tables hold their old `tenant_id` values under the new name;
 *   - no table or index was rebuilt: every `sqlite_master` rootpage is unchanged,
 *     and the migration holds only ADD COLUMN and RENAME COLUMN statements.
 */

import { openDatabase, type SqlDatabase, type SqlParam } from '@podium/runtime/sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TABLE_MANIFEST } from '../store/workspace-manifest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const M1 = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_workspace-column'))

/** Workspace tables a later migration creates, already keyed by workspace (POD-7013). */
const CREATED_AFTER_M1 = new Set(['workspace_meta', 'workspace_secrets'])

/** The workspace tables the migration chain creates before M1 (planned and runtime ones excluded). */
const WORKSPACE_TABLES = Object.entries(TABLE_MANIFEST)
  .filter(([, entry]) => entry.class === 'workspace' && entry.origin === 'schema')
  .map(([name]) => name)
  .filter((name) => !CREATED_AFTER_M1.has(name))
  .sort()

/** The sync tables whose `tenant_id` M1 renames; every other workspace table gains the column. */
const RENAMED = ['changes', 'sync_feed', 'sync_kind']

/** Their shipping triggers refuse a generic row; the test states it rather than skipping silently. */
const UNSEEDABLE = ['ship_orders', 'ship_train_active_claims']

type Row = Record<string, unknown>

interface Column {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly pk: number
}

const columnsOf = (db: SqlDatabase, table: string): Column[] =>
  db
    .prepare('SELECT name, type, "notnull", pk FROM pragma_table_xinfo(?) WHERE hidden = 0')
    .all(table) as Column[]

/**
 * A value for `column` that its type and the table's CHECK constraints accept:
 * the first literal of an `IN (…)` list or an `= '…'` / `= n` test on the
 * column, a 64-character hex string for a digest, otherwise a value naming the
 * table, column and row (so two rows and two tables never hold the same text).
 */
function valueFor(table: string, ddl: string, column: Column, row: number): SqlParam {
  // The sync tables' tenant is the one workspace of a self-hosted install.
  if (column.name === 'tenant_id') return 'local'
  if (table === 'machines' && column.name === 'public_key') return null
  if (table === 'machines' && column.name === 'token_hash') return `token-hash-${row}`
  const name = `(?<![\\w])[\`"]?${column.name}[\`"]?`
  const listed = new RegExp(`${name}\\s+IN\\s*\\(\\s*'([^']*)'`, 'i').exec(ddl)?.[1]
  if (listed !== undefined) return listed
  const equalsText = new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(ddl)?.[1]
  if (equalsText !== undefined) return equalsText
  const equalsNumber = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'i').exec(ddl)
  if (equalsNumber) return Number(equalsNumber[1])
  if (column.name.endsWith('_digest')) return String(row).repeat(64)
  const type = column.type.toUpperCase()
  if (type.includes('INT')) return row
  if (type.includes('REAL')) return row + 0.5
  return `${table}.${column.name}.${row}`
}

/** Insert two rows; when the first shape fails, retry with every nullable column NULL. */
function seed(db: SqlDatabase, table: string): void {
  const columns = columnsOf(db, table)
  const ddl = (
    db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }
  ).sql
  const insert = db.prepare(
    `INSERT INTO "${table}" (${columns.map((c) => `"${c.name}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  )
  for (const row of [1, 2]) {
    const full = columns.map((c) => valueFor(table, ddl, c, row))
    const sparse = columns.map((c, i) => (c.notnull === 0 && c.pk === 0 ? null : (full[i] ?? null)))
    try {
      insert.run(...full)
    } catch {
      try {
        insert.run(...sparse)
      } catch {
        return
      }
    }
  }
}

/** Rows in a stable order that depends on neither a key nor the column order. */
const canonical = (rows: Row[]): Row[] =>
  rows
    .map((row) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
    .sort()
    .map((text) => Object.fromEntries(JSON.parse(text) as [string, unknown][]))

const rowsOf = (db: SqlDatabase, table: string): Row[] =>
  canonical(db.prepare(`SELECT * FROM "${table}"`).all() as Row[])

const rootpages = (db: SqlDatabase): Map<string, number> =>
  new Map(
    (
      db
        .prepare(
          "SELECT type || ' ' || name AS name, rootpage FROM sqlite_master WHERE rootpage > 0",
        )
        .all() as { name: string; rootpage: number }[]
    ).map((row) => [row.name, row.rootpage]),
  )

const without = (row: Row, column: string): Row =>
  Object.fromEntries(Object.entries(row).filter(([name]) => name !== column))

describe('workspace column migration (M1)', () => {
  let db: SqlDatabase
  const before = new Map<string, Row[]>()
  let pagesBefore: Map<string, number>
  let applied: string[]

  beforeAll(() => {
    expect(M1, 'the workspace column migration is in the manifest').toBeGreaterThan(0)
    db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, M1))
    db.exec('PRAGMA foreign_keys = OFF')
    for (const table of WORKSPACE_TABLES) seed(db, table)
    // Read after all seeding: a trigger of one table may write another.
    for (const table of WORKSPACE_TABLES) before.set(table, rowsOf(db, table))
    pagesBefore = rootpages(db)
    applied = runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, M1 + 1))
  })
  afterAll(() => db.close())

  it('upgrades a fixture with rows in nearly every workspace table', () => {
    expect(applied.map((name) => name.replace(/^\d+_/, ''))).toEqual(['workspace-column'])
    expect(WORKSPACE_TABLES.length).toBeGreaterThan(100)
    const empty = WORKSPACE_TABLES.filter((table) => before.get(table)?.length === 0)
    expect(empty).toEqual(UNSEEDABLE)
    for (const table of RENAMED) {
      expect(before.get(table)?.length, table).toBeGreaterThan(0)
      expect(Object.keys(before.get(table)?.[0] ?? {}), table).toContain('tenant_id')
    }
  })

  it("gives every row of every workspace table workspace_id = 'local', not null", () => {
    for (const table of WORKSPACE_TABLES) {
      const column = columnsOf(db, table).find((c) => c.name === 'workspace_id')
      // sync_feed's is its text primary key, renamed in place: SQLite lets such
      // a key hold NULL, and NOT NULL arrives with the keys rebuild (POD-7024).
      // The row check below still finds no NULL in it.
      expect(column?.notnull === 1 || (column?.pk ?? 0) > 0, table).toBe(true)
      const counts = db
        .prepare(
          `SELECT count(*) AS total, count(*) FILTER (WHERE workspace_id = 'local') AS local FROM "${table}"`,
        )
        .get() as { total: number; local: number }
      expect(counts.local, table).toBe(counts.total)
    }
  })

  it('keeps every row and its content; the sync tables keep their tenant under the new name', () => {
    for (const table of WORKSPACE_TABLES) {
      const old = before.get(table) ?? []
      const now = rowsOf(db, table)
      if (RENAMED.includes(table)) {
        expect(
          columnsOf(db, table).map((c) => c.name),
          table,
        ).not.toContain('tenant_id')
        const renamed = old.map(({ tenant_id, ...rest }) => ({ ...rest, workspace_id: tenant_id }))
        expect(now, table).toEqual(canonical(renamed))
      } else {
        expect(canonical(now.map((row) => without(row, 'workspace_id'))), table).toEqual(old)
      }
    }
  })

  it('rebuilds no table or index: every rootpage is unchanged', () => {
    expect(rootpages(db)).toEqual(pagesBefore)
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })

  it('holds only ADD COLUMN and RENAME COLUMN statements', () => {
    const sql = DRIZZLE_MIGRATIONS[M1]?.sql ?? ''
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((s) => s.length > 0)
    const add = /^ALTER TABLE `(\w+)` ADD `workspace_id` text DEFAULT 'local' NOT NULL;$/
    const rename = /^ALTER TABLE `(\w+)` RENAME COLUMN `tenant_id` TO `workspace_id`;$/
    expect(statements.filter((s) => !add.test(s) && !rename.test(s))).toEqual([])
    const added = statements.flatMap((s) => add.exec(s)?.[1] ?? [])
    const renamed = statements.flatMap((s) => rename.exec(s)?.[1] ?? [])
    expect(renamed.sort()).toEqual(RENAMED)
    expect([...added, ...renamed].sort()).toEqual(WORKSPACE_TABLES)
  })
})
