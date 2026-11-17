/**
 * THE WORKSPACE UPGRADE, MEASURED [POD-7025; POD-6959 design 2.6 "Measured duration"].
 *
 * Times the workspace column migration (M1, POD-7012) and the keys migration (M2, POD-7024)
 * together, the way a boot runs them: the preflight, the pre-migration backup, and every
 * pending migration through the keys in one transaction with foreign keys off. The backup's
 * own time is read from the boot stage it logs, so it is reported apart.
 *
 * Two steps, on two hosts:
 *
 *   profile <reference.db>   reads row counts and dbstat sizes of a reference database IN
 *                            PLACE (mode=ro, immutable=1: nothing is copied, nothing written)
 *                            and prints them as JSON. No row content leaves the file.
 *   run <profile.json>       builds a synthetic database from the profile in a temp directory
 *                            (the chain to the migration before M1, every table at the
 *                            profile's row count with rows padded to its average size, the
 *                            search tables stood in by one filler table of their size, free
 *                            pages from a dropped filler), upgrades it, and prints one JSON line.
 *
 * The synthetic rows follow `migrations/workspace-keys.test.ts`: row n holds `v<n>` in each text
 * column and n in each integer column, a column a CHECK holds to a list takes a value from it,
 * and the shipping checks take the values listed in OVERRIDES.
 *
 *   bun --conditions=@podium/source scripts/server-data-bench/workspace-upgrade.ts profile <db>
 *   bun --conditions=@podium/source scripts/server-data-bench/workspace-upgrade.ts run <json>
 */
import { constants, Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSink } from '@podium/logger'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { DRIZZLE_MIGRATIONS } from '../../apps/server/src/migrations/drizzle-manifest.generated'
import { runDrizzleMigrations } from '../../apps/server/src/migrations/index'
import { withMigrationForeignKeysDisabled } from '../../apps/server/src/migrations/store-lifecycle'

interface TableProfile {
  readonly rows: number
  /** The table's own b-tree pages (dbstat), without its indexes. */
  readonly bytes: number
}

interface Profile {
  readonly pageSize: number
  readonly pageCount: number
  readonly freePages: number
  readonly tables: Record<string, TableProfile>
  /** The full-text search tables and their shadow tables, together. */
  readonly searchBytes: number
}

const M1 = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_workspace-column'))
const M2 = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_workspace-keys'))
if (M1 < 0 || M2 < M1) throw new Error('the workspace column or keys migration is missing')
const BEFORE_M1 = DRIZZLE_MIGRATIONS.slice(0, M1)
const THROUGH_M2 = DRIZZLE_MIGRATIONS.slice(0, M2 + 1)

const SEARCH = /^(conversations|transcript)_fts/
const SKIPPED = new Set(['__drizzle_migrations', 'sqlite_sequence', 'sqlite_stat1'])
const ALWAYS_EMPTY = new Set(['sync_capture', 'sync_capture_guard'])
const SINGLETONS = new Set(['feed_identity', 'ship_recovery_revision'])
/** Tables whose insert guards read other tables: filled after those, in this order. */
const LAST = ['ship_train_manifests', 'ship_train_members', 'ship_train_active_claims']

const hex = (n: number) => (n % 256).toString(16).padStart(2, '0').repeat(32)

/** What the generic rule cannot guess (as `migrations/workspace-keys.test.ts`). */
const OVERRIDES: Record<string, (n: number) => string | number | null> = {
  'delivery_receipts.validation_result': () => 'passed',
  'machines.credential_kind': () => 'bearer-hash',
  'machines.public_key': () => null,
  'ship_orders.state': () => 'queued',
  'ship_orders.hold_code': () => null,
  'ship_order_stack_edges.lower_order_id': (n) => `v${n + 1_000_000_000}`,
  'ship_steps.state': () => 'planned',
  'ship_steps.started_at': () => null,
  'ship_steps.finished_at': () => null,
  'ship_steps.outcome': () => null,
  'ship_train_manifests.version': () => 1,
  'ship_train_manifests.repair_round': () => 0,
  'ship_train_manifests.member_count': () => 1,
  'ship_train_manifests.released_at': () => null,
  'ship_train_manifests.release_reason': () => null,
  'ship_train_members.ordinal': () => 0,
  'feed_identity.singleton': () => 1,
}

// ---- profile ------------------------------------------------------------------------------

function profile(path: string): Profile {
  // Read in place: read-only and immutable, so SQLite takes no lock and writes no WAL or SHM.
  const db = new Database(
    `file:${path}?mode=ro&immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  )
  try {
    const pragma = (name: string) =>
      (db.query(`PRAGMA ${name}`).get() as Record<string, number>)[name] as number
    const tables: Record<string, TableProfile> = {}
    let searchBytes = 0
    const sizes = new Map(
      (
        db.query('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name').all() as {
          name: string
          bytes: number
        }[]
      ).map((row) => [row.name, row.bytes]),
    )
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((row) => row.name)
    for (const name of names) {
      if (SEARCH.test(name)) {
        searchBytes += sizes.get(name) ?? 0
        continue
      }
      if (SKIPPED.has(name) || name.startsWith('sqlite_')) continue
      const rows = (db.query(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n
      tables[name] = { rows, bytes: sizes.get(name) ?? 0 }
    }
    return {
      pageSize: pragma('page_size'),
      pageCount: pragma('page_count'),
      freePages: pragma('freelist_count'),
      tables,
      searchBytes,
    }
  } finally {
    db.close()
  }
}

// ---- the synthetic database ---------------------------------------------------------------

interface Column {
  name: string
  type: string
  pk: number
}

const columnsOf = (db: SqlDatabase, table: string): Column[] =>
  db.prepare('SELECT name, type, pk FROM pragma_table_info(?)').all(table) as Column[]

const tableSql = (db: SqlDatabase, table: string): string =>
  (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql

/** Columns that name a key, an index, a foreign key or a CHECK: never the padding. */
function boundColumns(db: SqlDatabase, table: string): Set<string> {
  const bound = new Set<string>()
  for (const column of columnsOf(db, table)) if (column.pk > 0) bound.add(column.name)
  const indexes = db.prepare('SELECT name FROM pragma_index_list(?)').all(table) as {
    name: string
  }[]
  for (const index of indexes) {
    for (const column of db.prepare('SELECT name FROM pragma_index_info(?)').all(index.name) as {
      name: string | null
    }[]) {
      if (column.name) bound.add(column.name)
    }
  }
  for (const fk of db
    .prepare('SELECT "from" AS name FROM pragma_foreign_key_list(?)')
    .all(table) as { name: string }[]) {
    bound.add(fk.name)
  }
  const sql = tableSql(db, table)
  for (const column of columnsOf(db, table)) {
    if (new RegExp(`CHECK\\s*\\([^)]*\\b${column.name}\\b`, 'i').test(sql)) bound.add(column.name)
  }
  return bound
}

/** A row maker for `table`: row n by the rule in the header, padded to `rowBytes`. */
function rowMaker(db: SqlDatabase, table: string, rowBytes: number) {
  const sql = tableSql(db, table)
  const columns = columnsOf(db, table)
  const bound = boundColumns(db, table)
  const pad = columns.find((c) => /TEXT/i.test(c.type) && !bound.has(c.name))?.name
  const listed = new Map<string, string[]>()
  for (const { name } of columns) {
    const match = new RegExp(`[\\s(\`"]${name}[\`"]?\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql)
    const literals = match?.[1]?.match(/'[^']*'/g)
    if (literals)
      listed.set(
        name,
        literals.map((literal) => literal.slice(1, -1)),
      )
  }
  // About ten bytes a column of record header and short values, then the padding.
  const padding = pad === undefined ? '' : 'x'.repeat(Math.max(0, rowBytes - 10 * columns.length))
  return {
    names: columns.map((c) => c.name),
    row(n: number): (string | number | null)[] {
      return columns.map(({ name, type }) => {
        const override = OVERRIDES[`${table}.${name}`]
        if (override !== undefined) return override(n)
        if (name.endsWith('_digest')) return hex(n)
        const literals = listed.get(name)
        if (literals !== undefined) return literals[(n - 1) % literals.length]!
        if (/INT/i.test(type)) return n
        if (/REAL/i.test(type)) return n + 0.5
        return name === pad ? `v${n}${padding}` : `v${n}`
      })
    },
  }
}

function fill(db: SqlDatabase, profiled: Profile): Record<string, number> {
  db.exec('PRAGMA foreign_keys = OFF')
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !SKIPPED.has(name) && !SEARCH.test(name) && !ALWAYS_EMPTY.has(name))
  const ordered = [
    ...tables.filter((t) => !LAST.includes(t)),
    ...LAST.filter((t) => tables.includes(t)),
  ]
  const planted: Record<string, number> = {}
  for (const table of ordered) {
    const reference = profiled.tables[table]
    if (reference === undefined || reference.rows === 0) continue
    const existing = (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n
    if (SINGLETONS.has(table) && existing > 0) continue
    const rows = SINGLETONS.has(table) ? 1 : reference.rows - existing
    const maker = rowMaker(db, table, Math.floor(reference.bytes / reference.rows))
    const insert = db.prepare(
      `INSERT INTO "${table}" (${maker.names.map((name) => `"${name}"`).join(', ')}) VALUES (${maker.names.map(() => '?').join(', ')})`,
    )
    db.exec('BEGIN')
    for (let n = 1; n <= rows; n++) insert.run(...maker.row(n))
    db.exec('COMMIT')
    planted[table] = rows
  }
  // The search tables, made at boot and not rebuilt by the upgrade, stood in by one table of
  // their size; then the reference's free pages, from a filler that is dropped.
  const filler = (name: string, bytes: number) => {
    db.exec(`CREATE TABLE ${name} (b BLOB)`)
    const insert = db.prepare(`INSERT INTO ${name} VALUES (randomblob(?))`)
    db.exec('BEGIN')
    for (let left = bytes; left > 0; left -= 3500) insert.run(Math.min(3500, left))
    db.exec('COMMIT')
  }
  filler('bench_search_filler', profiled.searchBytes)
  filler('bench_free_filler', profiled.freePages * profiled.pageSize)
  db.exec('DROP TABLE bench_free_filler')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return planted
}

// ---- run ----------------------------------------------------------------------------------

function run(profilePath: string): void {
  const profiled = JSON.parse(readFileSync(profilePath, 'utf8')) as Profile
  const dir = mkdtempSync(join(tmpdir(), 'workspace-upgrade-'))
  const path = join(dir, 'podium.db')
  try {
    const buildStarted = performance.now()
    const seeded = openDatabase(path)
    seeded.exec('PRAGMA journal_mode = WAL')
    runDrizzleMigrations(seeded, BEFORE_M1)
    const planted = fill(seeded, profiled)
    const counts = rowCounts(seeded)
    seeded.close()
    const buildMs = performance.now() - buildStarted
    const fileBytes = statSync(path).size

    const stages: Record<string, number> = {}
    const dispose = addSink({
      name: 'workspace-upgrade-bench',
      write: (record) => {
        const fields = record as unknown as {
          msg?: string
          stage?: string
          stageDurationMs?: number
        }
        if (fields.msg === 'boot stage completed' && fields.stage !== undefined) {
          stages[fields.stage] = fields.stageDurationMs ?? 0
        }
      },
    })
    const db = openDatabase(path)
    const load = loadavg()[0]!
    const started = performance.now()
    let applied: string[]
    try {
      applied = withMigrationForeignKeysDisabled(db, () =>
        runDrizzleMigrations(db, THROUGH_M2, { dbPath: path }),
      )
    } finally {
      dispose()
    }
    const totalMs = performance.now() - started
    const after = rowCounts(db)
    const changed = Object.keys(counts).filter((table) => after[table] !== counts[table])
    db.close()
    const shortTables = Object.entries(profiled.tables)
      .filter(([table, p]) => p.rows > 0 && planted[table] === undefined && !SINGLETONS.has(table))
      .map(([table]) => table)
    console.log(
      JSON.stringify({
        loadBefore: Math.round(load * 100) / 100,
        loadAfter: Math.round(loadavg()[0]! * 100) / 100,
        fileBytes,
        buildMs: Math.round(buildMs),
        totalMs: Math.round(totalMs),
        backupMs: stages.backup ?? null,
        migrationsMs: Math.round(totalMs - (stages.backup ?? 0)),
        applied,
        plantedRows: Object.values(planted).reduce((a, b) => a + b, 0),
        tablesWithoutReferenceRows: shortTables,
        rowCountsChanged: changed,
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function rowCounts(db: SqlDatabase): Record<string, number> {
  const out: Record<string, number> = {}
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'bench_%'",
    )
    .all() as { name: string }[]) {
    if (SEARCH.test(name) || SKIPPED.has(name)) continue
    out[name] = (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n
  }
  return out
}

const [command, argument] = process.argv.slice(2)
if (command === 'profile' && argument) console.log(JSON.stringify(profile(argument), null, 2))
else if (command === 'run' && argument) run(argument)
else {
  console.error('usage: workspace-upgrade.ts profile <reference.db> | run <profile.json>')
  process.exit(2)
}
