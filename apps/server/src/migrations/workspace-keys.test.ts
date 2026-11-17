/**
 * THE KEYS MIGRATION, ON A DATABASE WITH ROWS IN EVERY TABLE [POD-7024; POD-6959 design 2.2,
 * 2.3, 2.6 "What M2 must keep"].
 *
 * The keys migration rebuilds every workspace table so its keys and indexes lead with
 * workspace_id. A rebuild that drops a column, a row, a rowid, an AUTOINCREMENT counter or a
 * trigger does so silently: the ledger still reads complete. So this test plants rows in EVERY
 * table of the database just before the migration, upgrades it the way a boot does (backup
 * first, foreign keys off around the one transaction), and compares.
 *
 * THE FIXTURE. Row n of every table holds `v<n>` in each text column and n in each integer
 * column, so every foreign key finds its parent (`issue_comments.issue_id = 'v1'` is
 * `issues.id = 'v1'`) without a hand-written graph. A column a CHECK holds to a list takes a
 * value from that list; the rest of what the shipping checks and guard triggers require is in
 * {@link OVERRIDES}. Rowids are planted out of insertion order, and every AUTOINCREMENT counter
 * stands above its table's newest id, so a rebuild that renumbered either would be seen.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it } from 'vitest'
import * as syncPgSchema from '../../../../packages/sync/src/adapters/pg/schema'
import { captureLogs } from '../test-support/capture-logs'
import { retainedSnapshotPaths } from './backup'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'
import { newerDatabaseMessage } from './ledger-guards'
import * as pgSchema from './pg/schema'
import { withMigrationForeignKeysDisabled } from './store-lifecycle'

const KEYS = DRIZZLE_MIGRATIONS.findIndex((migration) => migration.name.endsWith('_workspace-keys'))
const KEYS_NAME = DRIZZLE_MIGRATIONS[KEYS]!.name
const BEFORE_KEYS = DRIZZLE_MIGRATIONS.slice(0, KEYS)

/** The seven tables whose integer id is a global surrogate (design 2.2). */
const AUTOINCREMENT = [
  'issue_text_revisions',
  'labels',
  'lock_waiters',
  'podium_events',
  'settings_audit_events',
  'superagent_messages',
  'workflow_events',
]

/** Tables that may hold one row only; the chain may have written it already. */
const SINGLETONS = new Set(['feed_identity', 'ship_recovery_revision'])

/** Written by the migrator or SQLite, compared on their own terms. */
const SKIPPED = new Set(['__drizzle_migrations', 'sqlite_sequence', 'sqlite_stat1'])

/**
 * Change capture's rows live inside one write transaction (POD-6920): outside one both tables
 * are empty, and a row in either would refuse every commit. Compared, never planted.
 */
const ALWAYS_EMPTY = new Set(['sync_capture', 'sync_capture_guard'])

const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32)

/**
 * What the generic rule cannot guess: the shipping checks (lifecycle pairs, digests, the one
 * train shape the claim guard accepts), and the machine credential. `null` leaves a column
 * empty. Everything else follows the generic rule.
 */
const OVERRIDES: Record<string, (n: number) => string | number | null> = {
  'delivery_receipts.validation_result': () => 'passed',
  'machines.credential_kind': () => 'bearer-hash',
  'machines.public_key': () => null,
  'ship_orders.state': () => 'queued',
  'ship_orders.hold_code': () => null,
  'ship_order_stack_edges.lower_order_id': (n) => `v${3 - n}`,
  'ship_steps.state': () => 'planned',
  'ship_steps.started_at': () => null,
  'ship_steps.finished_at': () => null,
  'ship_steps.outcome': () => null,
  'ship_train_manifests.version': () => 1,
  'ship_train_manifests.repair_round': () => 0,
  'ship_train_manifests.member_count': () => 1,
  'ship_train_manifests.released_at': () => null,
  'ship_train_manifests.release_reason': () => null,
  // The train's one member is its leader at ordinal 0 (the final-leader and claim guards).
  'ship_train_members.ordinal': () => 0,
  'feed_identity.singleton': () => 1,
}

/** Tables whose insert guards read other tables: planted after those, in this order. */
const LAST = ['ship_train_manifests', 'ship_train_members', 'ship_train_active_claims']

type Row = Record<string, unknown>

interface Column {
  name: string
  type: string
}

const tableNames = (db: SqlDatabase): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !SKIPPED.has(name) && !/^(conversations|transcript)_fts/.test(name))

const columnsOf = (db: SqlDatabase, table: string): Column[] =>
  db.prepare('SELECT name, type FROM pragma_table_info(?)').all(table) as Column[]

const tableSql = (db: SqlDatabase, table: string): string =>
  (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql

const hasIntegerKey = (db: SqlDatabase, table: string): boolean => {
  const keys = db.prepare('SELECT type FROM pragma_table_info(?) WHERE pk > 0').all(table) as {
    type: string
  }[]
  return keys.length === 1 && /^integer$/i.test(keys[0]!.type)
}

/** A table with one row per workspace: the fixture's one workspace holds one. */
const keyedByWorkspaceAlone = (db: SqlDatabase, table: string): boolean => {
  const keys = db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0').all(table) as {
    name: string
  }[]
  return keys.length === 1 && keys[0]!.name === 'workspace_id'
}

/** Row n of `table`, by the rule in the header. */
function fixtureRow(db: SqlDatabase, table: string, n: number): Row {
  const sql = tableSql(db, table)
  const row: Row = {}
  for (const { name, type } of columnsOf(db, table)) {
    const override = OVERRIDES[`${table}.${name}`]
    if (override !== undefined) {
      row[name] = override(n)
    } else if (name === 'workspace_id') {
      row[name] = 'local'
    } else if (name.endsWith('_digest')) {
      row[name] = hex(n)
    } else {
      const listed = new RegExp(`[\\s(\`"]${name}[\`"]?\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql)
      const literals = listed?.[1]?.match(/'[^']*'/g)
      if (literals !== undefined && literals !== null) {
        row[name] = literals[(n - 1) % literals.length]!.slice(1, -1)
      } else {
        row[name] = /INT/i.test(type) ? n : /REAL/i.test(type) ? n + 0.5 : `v${n}`
      }
    }
  }
  return row
}

function insert(db: SqlDatabase, table: string, row: Row, rowid?: number): void {
  const names = Object.keys(row)
  const columns = [...(rowid === undefined ? [] : ['rowid']), ...names.map((name) => `"${name}"`)]
  const values = [...(rowid === undefined ? [] : [rowid]), ...names.map((name) => row[name])]
  db.prepare(
    `INSERT INTO "${table}" (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...(values as (string | number | null)[]))
}

/**
 * Two rows in every table (one in a singleton), with rowids planted against insertion order
 * (row 1 at rowid 93, row 2 at 86) where the rowid is not the integer key, and every
 * AUTOINCREMENT counter at 500.
 */
function plantEveryTable(db: SqlDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF')
  const tables = tableNames(db)
  const ordered = [
    ...tables.filter((t) => !LAST.includes(t)),
    ...LAST.filter((t) => tables.includes(t)),
  ]
  for (const table of ordered.filter((name) => !ALWAYS_EMPTY.has(name))) {
    const count = (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n
    const single = SINGLETONS.has(table) || keyedByWorkspaceAlone(db, table)
    if (single && count > 0) continue
    for (const n of single ? [1] : [1, 2]) {
      insert(
        db,
        table,
        fixtureRow(db, table, n),
        hasIntegerKey(db, table) ? undefined : 100 - 7 * n,
      )
    }
  }
  for (const table of AUTOINCREMENT) {
    db.prepare('UPDATE sqlite_sequence SET seq = 500 WHERE name = ?').run(table)
  }
}

/** Every row of every table, by rowid, and the AUTOINCREMENT counters. */
function contentOf(db: SqlDatabase): Record<string, Row[]> {
  const content: Record<string, Row[]> = {}
  for (const table of tableNames(db)) {
    content[table] = db
      .prepare(`SELECT rowid AS __rowid, * FROM "${table}" ORDER BY rowid`)
      .all() as Row[]
  }
  content.sqlite_sequence = db
    .prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name')
    .all() as Row[]
  return content
}

const triggerNames = (db: SqlDatabase): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
      name: string
    }[]
  ).map((row) => row.name)

/**
 * Try what each trigger guards, once, and say what happened: the refusal's message, or `ok`.
 * Each try runs in a savepoint that is rolled back. An UPDATE sets a column to itself (a
 * BEFORE UPDATE trigger fires on any update, an UPDATE OF trigger on its first column), a
 * DELETE removes the first row, and an INSERT copies the first row (a BEFORE INSERT guard
 * speaks before the copy's duplicate key would).
 */
function probeTriggers(db: SqlDatabase): Record<string, string> {
  const outcomes: Record<string, string> = {}
  const triggers = db
    .prepare("SELECT name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'trigger'")
    .all() as { name: string; tableName: string; sql: string }[]
  for (const { name, tableName, sql } of triggers) {
    const event = /\b(INSERT|UPDATE|DELETE)\b(?:\s+OF\s+([\s\S]+?)\s+ON\s)?/i.exec(sql)!
    const first = `(SELECT min(rowid) FROM "${tableName}")`
    const column =
      event[2]?.split(',')[0]?.trim().replaceAll('`', '') ?? columnsOf(db, tableName)[0]!.name
    const statement =
      event[1]!.toUpperCase() === 'UPDATE'
        ? `UPDATE "${tableName}" SET "${column}" = "${column}" WHERE rowid = ${first}`
        : event[1]!.toUpperCase() === 'DELETE'
          ? `DELETE FROM "${tableName}" WHERE rowid = ${first}`
          : `INSERT INTO "${tableName}" SELECT * FROM "${tableName}" WHERE rowid = ${first}`
    db.exec('SAVEPOINT probe')
    try {
      db.exec(statement)
      outcomes[name] = 'ok'
    } catch (error) {
      // A duplicate key's message names the key's columns, which now lead with workspace_id.
      outcomes[name] = (error as Error).message.replace(/^(UNIQUE constraint failed):.*/, '$1')
    } finally {
      db.exec('ROLLBACK TO probe')
      db.exec('RELEASE probe')
    }
  }
  return outcomes
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A database file one migration before the keys, with rows in every table. */
function plantedDatabase(): { path: string; db: SqlDatabase } {
  const root = mkdtempSync(join(tmpdir(), 'workspace-keys-'))
  roots.push(root)
  const path = join(root, 'podium.db')
  const db = openDatabase(path)
  db.exec('PRAGMA journal_mode = WAL')
  runDrizzleMigrations(db, BEFORE_KEYS)
  plantEveryTable(db)
  return { path, db }
}

/** The boot's upgrade: foreign keys off around the migrator, which backs up first. */
function upgrade(db: SqlDatabase, path: string, freeBytes?: (dir: string) => number): string[] {
  return withMigrationForeignKeysDisabled(db, () =>
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS, { dbPath: path, freeBytes }),
  )
}

describe('POD-7024 — the workspace keys migration', () => {
  it('is the newest migration of the manifest', () => {
    expect(KEYS).toBeGreaterThan(0)
    expect(KEYS).toBe(DRIZZLE_MIGRATIONS.length - 1)
  })

  it('keeps every row of every table, its rowid and every AUTOINCREMENT counter', () => {
    const { path, db } = plantedDatabase()
    const before = contentOf(db)
    // Not vacuous: every table holds rows, and the counters stand above the newest ids.
    const empty = Object.entries(before).filter(
      ([table, rows]) => rows.length === 0 && !ALWAYS_EMPTY.has(table),
    )
    expect(empty.map(([table]) => table)).toEqual([])
    expect(Object.keys(before).length).toBeGreaterThan(120)
    for (const table of AUTOINCREMENT) {
      expect(before.sqlite_sequence).toContainEqual({ name: table, seq: 500 })
    }

    const logs = captureLogs()
    try {
      expect(upgrade(db, path)).toEqual([KEYS_NAME])
    } finally {
      logs.restore()
    }

    const after = contentOf(db)
    // The legacy singleton is dropped (design 2.1); every other table is as it was.
    expect(after.feed_identity).toBeUndefined()
    const { feed_identity: _dropped, ...kept } = before
    expect(after).toEqual(kept)

    // A new AUTOINCREMENT row continues above the carried counter, not above the newest row.
    db.prepare(
      "INSERT INTO labels (name, created_at, workspace_id) VALUES ('after', 'v9', 'local')",
    ).run()
    expect(db.prepare("SELECT id FROM labels WHERE name = 'after'").get()).toEqual({ id: 501 })

    // One progress line per rebuilt table (design 2.6, P-OD1).
    const progress = logs.records.filter((record) => record.msg === 'rebuilt table')
    expect(progress.length).toBeGreaterThan(100)
    expect(progress.at(-1)).toMatchObject({ done: progress.length, of: progress.length })
    expect(progress.map((record) => record.table)).toContain('sessions')
    // The indexes drizzle-kit writes after the rebuilds have their own line.
    expect(logs.records.filter((record) => record.msg === 'built indexes')).toHaveLength(1)
    db.close()
  })

  it('leads every key and index of a workspace table with workspace_id, with no default', () => {
    const { path, db } = plantedDatabase()
    upgrade(db, path)
    const workspaceTables = tableNames(db).filter((table) =>
      columnsOf(db, table).some((column) => column.name === 'workspace_id'),
    )
    const wrong: string[] = []
    for (const table of workspaceTables) {
      if (table.startsWith('identity_')) continue
      const column = db
        .prepare(
          `SELECT "notnull" AS not_null, dflt_value AS fallback FROM pragma_table_info(?) WHERE name = 'workspace_id'`,
        )
        .get(table) as { not_null: number; fallback: string | null }
      if (column.not_null !== 1 || column.fallback !== null) wrong.push(`${table}: column`)
      const indexes = db.prepare('SELECT name, origin FROM pragma_index_list(?)').all(table) as {
        name: string
        origin: string
      }[]
      for (const index of indexes) {
        const lead = db
          .prepare('SELECT name FROM pragma_index_xinfo(?) WHERE seqno = 0')
          .get(index.name) as { name: string | null }
        if (lead.name !== 'workspace_id') wrong.push(`${table}: ${index.name}`)
      }
      const integerKey = hasIntegerKey(db, table)
      const keyLead = db
        .prepare('SELECT name FROM pragma_table_info(?) WHERE pk = 1')
        .get(table) as { name: string }
      if (!integerKey && keyLead.name !== 'workspace_id') wrong.push(`${table}: primary key`)
      if (integerKey && !AUTOINCREMENT.includes(table)) wrong.push(`${table}: integer key`)
      const fks = db
        .prepare('SELECT id, seq, "from", "to" FROM pragma_foreign_key_list(?)')
        .all(table) as {
        id: number
        seq: number
        from: string
        to: string
      }[]
      for (const fk of fks.filter((key) => key.seq === 0)) {
        if (fk.from !== 'workspace_id' || fk.to !== 'workspace_id')
          wrong.push(`${table}: fk ${fk.id}`)
      }
    }
    expect(workspaceTables.length).toBeGreaterThan(100)
    expect(wrong).toEqual([])
    db.close()
  })

  /**
   * The same rule on the Postgres twin, which also holds the tables and indexes only Postgres
   * has (`PG_ONLY_TABLES`, `PG_ONLY_INDEXES`): the SQLite case above cannot see them.
   */
  it('leads every key and index of a Postgres workspace table with workspace_id too', () => {
    // A tsvector GIN index cannot lead with a text column (that needs the btree_gin
    // extension); each search names `workspace_id` on the row it matches.
    const isSearchIndex = (method: string | undefined) => method === 'gin'
    // A global identity no foreign key or conflict target names, unlike the seven
    // AUTOINCREMENT ids, which carry UNIQUE (workspace_id, id) for the composite references.
    const SURROGATE_WITHOUT_UNIQUE = new Set(['transcript_text'])
    const tables = new Map<string, PgTable>()
    for (const value of [...Object.values(pgSchema), ...Object.values(syncPgSchema)]) {
      if (is(value, PgTable)) tables.set(getTableConfig(value).name, value)
    }
    const wrong: string[] = []
    let workspaceTables = 0
    for (const [name, table] of tables) {
      if (name.startsWith('identity_')) continue
      const config = getTableConfig(table)
      const workspace = config.columns.find((column) => column.name === 'workspace_id')
      if (workspace === undefined) continue
      workspaceTables += 1
      if (!workspace.notNull || workspace.hasDefault) wrong.push(`${name}: column`)
      const columnKey = config.columns.filter((column) => column.primary).map((c) => c.name)
      const key =
        columnKey.length > 0 ? columnKey : (config.primaryKeys[0]?.columns ?? []).map((c) => c.name)
      const uniques = config.uniqueConstraints.map((u) => u.columns.map((c) => c.name))
      if (key.length === 1 && key[0] === 'id') {
        const paired = uniques.some((u) => u[0] === 'workspace_id' && u[1] === 'id')
        if (!AUTOINCREMENT.includes(name) && !SURROGATE_WITHOUT_UNIQUE.has(name))
          wrong.push(`${name}: integer key`)
        if (AUTOINCREMENT.includes(name) && !paired)
          wrong.push(`${name}: unique (workspace_id, id)`)
      } else if (key[0] !== 'workspace_id') {
        wrong.push(`${name}: primary key`)
      }
      for (const unique of uniques) if (unique[0] !== 'workspace_id') wrong.push(`${name}: unique`)
      for (const column of config.columns) {
        if (column.isUnique && column.name !== 'workspace_id')
          wrong.push(`${name}: ${column.name} unique`)
      }
      for (const index of config.indexes) {
        const first = index.config.columns[0] as { name?: string } | undefined
        if (isSearchIndex(index.config.method)) continue
        if (first?.name !== 'workspace_id') wrong.push(`${name}: ${index.config.name}`)
      }
      for (const fk of config.foreignKeys) {
        const reference = fk.reference()
        if (
          reference.columns[0]?.name !== 'workspace_id' ||
          reference.foreignColumns[0]?.name !== 'workspace_id'
        )
          wrong.push(`${name}: fk ${fk.getName()}`)
      }
    }
    expect(tables.has('transcript_text')).toBe(true)
    expect(workspaceTables).toBeGreaterThan(100)
    expect(wrong).toEqual([])
  })

  it('leaves no dangling reference and an intact file', () => {
    const { path, db } = plantedDatabase()
    // The fixture's references hold before the upgrade, so a finding after it is the upgrade's.
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    upgrade(db, path)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps every shipping guard refusing what it refused, and recreates every trigger', () => {
    const { path, db } = plantedDatabase()
    const names = triggerNames(db)
    const before = probeTriggers(db)
    upgrade(db, path)
    // Every trigger is back, plus the two that clear deleted references (see below).
    expect(triggerNames(db)).toEqual(
      [...names, 'issues_clear_references', 'workflow_runs_clear_supersedes'].sort(),
    )
    const after = probeTriggers(db)
    const { issues_clear_references: _a, workflow_runs_clear_supersedes: _b, ...guards } = after
    expect(guards).toEqual(before)
    // Not vacuous: most guards refuse their probe, each with its own message.
    const refused = Object.values(before).filter((outcome) => outcome !== 'ok')
    expect(refused.length).toBeGreaterThan(25)
    expect(
      refused.filter((outcome) => /immutable|append-only/.test(outcome)).length,
    ).toBeGreaterThan(20)
    db.close()
  })

  it('holds every guard lookup to the workspace of the row that fired it', () => {
    const { path, db } = plantedDatabase()
    const member = db
      .prepare('SELECT * FROM ship_train_members ORDER BY rowid LIMIT 1')
      .get() as Row
    // Train v1 has an active claim in the self-hosted workspace, so its members are sealed.
    const claimed = db
      .prepare("SELECT 1 AS one FROM ship_train_active_claims WHERE train_id = 'v1'")
      .get()
    expect(claimed).toEqual({ one: 1 })
    const intoOther = () =>
      insert(db, 'ship_train_members', {
        ...member,
        workspace_id: 'other',
        train_id: 'v1',
        ordinal: 0,
      })
    // Before the keys, the guard read every workspace's claims.
    db.exec('SAVEPOINT before_keys')
    expect(intoOther).toThrow(/sealed after active claim/)
    db.exec('ROLLBACK TO before_keys')
    db.exec('RELEASE before_keys')
    upgrade(db, path)
    // After them, another workspace's train v1 is its own: no claim there, nothing sealed. (The
    // composite foreign keys refuse a member of a train that workspace lacks; off, the guard
    // alone is what speaks.)
    db.exec('PRAGMA foreign_keys = OFF')
    expect(intoOther).not.toThrow()
    db.close()
  })

  it('clears a deleted issue or run from the rows that pointed at it, in its workspace only', () => {
    const { path, db } = plantedDatabase()
    upgrade(db, path)
    const issue = db.prepare('SELECT * FROM issues ORDER BY rowid LIMIT 1').get() as Row
    const plantIssue = (workspace: string, id: string, refs: string | null, seq: number) =>
      insert(db, 'issues', {
        ...issue,
        workspace_id: workspace,
        id,
        seq,
        parent_id: refs,
        superseded_by: refs,
        duplicate_of: refs,
      })
    plantIssue('local', 'iss_parent', null, 101)
    plantIssue('local', 'iss_child', 'iss_parent', 102)
    // The same ids in another workspace: a composite key holds them apart.
    plantIssue('other', 'iss_parent', null, 101)
    plantIssue('other', 'iss_child', 'iss_parent', 102)
    db.exec('PRAGMA foreign_keys = ON')
    db.prepare("DELETE FROM issues WHERE workspace_id = 'local' AND id = 'iss_parent'").run()
    const refs = (workspace: string) =>
      db
        .prepare(
          "SELECT parent_id, superseded_by, duplicate_of FROM issues WHERE workspace_id = ? AND id = 'iss_child'",
        )
        .get(workspace)
    expect(refs('local')).toEqual({ parent_id: null, superseded_by: null, duplicate_of: null })
    expect(refs('other')).toEqual({
      parent_id: 'iss_parent',
      superseded_by: 'iss_parent',
      duplicate_of: 'iss_parent',
    })

    const run = db.prepare('SELECT * FROM workflow_runs ORDER BY rowid LIMIT 1').get() as Row
    const plantRun = (id: string, supersedes: string | null) =>
      insert(db, 'workflow_runs', {
        ...run,
        id,
        status: 'complete',
        subject_id: id,
        supersedes_run_id: supersedes,
      })
    plantRun('run_old', null)
    plantRun('run_new', 'run_old')
    db.prepare("DELETE FROM workflow_runs WHERE workspace_id = 'local' AND id = 'run_old'").run()
    expect(
      db.prepare("SELECT supersedes_run_id FROM workflow_runs WHERE id = 'run_new'").get(),
    ).toEqual({ supersedes_run_id: null })
    // A reference into another workspace cannot exist at all.
    expect(() =>
      insert(db, 'issue_comments', {
        ...(db.prepare('SELECT * FROM issue_comments LIMIT 1').get() as Row),
        workspace_id: 'other',
        id: 'cmt_cross',
        issue_id: 'v1',
      }),
    ).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })

  it('backs up the database first; the backup opens and holds the rows as they were', () => {
    const { path, db } = plantedDatabase()
    const before = contentOf(db)
    upgrade(db, path)
    db.close()
    const [backup] = retainedSnapshotPaths(path)
    expect(backup).toBeDefined()
    const copy = openDatabase(backup!, { readOnly: true })
    try {
      expect(contentOf(copy)).toEqual(before)
      const ledger = copy.prepare('SELECT name FROM __drizzle_migrations').all() as {
        name: string
      }[]
      expect(ledger.map((row) => row.name)).not.toContain(KEYS_NAME)
    } finally {
      copy.close()
    }
  })

  it('is refused by an older build', () => {
    const { path, db } = plantedDatabase()
    upgrade(db, path)
    expect(() => runDrizzleMigrations(db, BEFORE_KEYS, { dbPath: path })).toThrow(
      newerDatabaseMessage(KEYS_NAME),
    )
    db.close()
  })

  it('is atomic: a failure in the middle leaves the database as it was', () => {
    const { path, db } = plantedDatabase()
    const before = contentOf(db)
    const schema = () =>
      db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()
    const schemaBefore = schema()
    const keys = DRIZZLE_MIGRATIONS[KEYS]!
    const statements = keys.sql.split('--> statement-breakpoint')
    const middle = statements.findIndex(
      (statement, index) => index > statements.length / 2 && /RENAME TO/.test(statement),
    )
    expect(middle).toBeGreaterThan(0)
    // What a crash does to a transaction, a failing statement does too: nothing commits.
    const broken = {
      ...keys,
      sql: [
        ...statements.slice(0, middle + 1),
        'SELECT * FROM no_such_table',
        ...statements.slice(middle + 1),
      ].join('--> statement-breakpoint'),
    }
    expect(() =>
      withMigrationForeignKeysDisabled(db, () =>
        runDrizzleMigrations(db, [...BEFORE_KEYS, broken], { dbPath: path }),
      ),
    ).toThrow(/no_such_table/)
    expect(schema()).toEqual(schemaBefore)
    expect(contentOf(db)).toEqual(before)
    // And the next boot upgrades it whole.
    expect(upgrade(db, path)).toEqual([KEYS_NAME])
    db.close()
  })

  it('refuses to start without free space for 2.5 times the database, and changes nothing', () => {
    const { path, db } = plantedDatabase()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const size = statSync(path).size
    const before = contentOf(db)
    expect(() => upgrade(db, path, () => Math.ceil(2.5 * size) - 1)).toThrow(
      /not enough free disk space.*Nothing was changed/,
    )
    expect(retainedSnapshotPaths(path)).toEqual([])
    expect(contentOf(db)).toEqual(before)
    expect(upgrade(db, path, () => Math.ceil(2.5 * size) + 1_000_000)).toEqual([KEYS_NAME])
    db.close()
  })
})
