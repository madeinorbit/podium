/**
 * Schema migration runtime [spec:SP-4428].
 *
 * drizzle-kit AUTHORS migrations (schema-as-code in schema.ts → `drizzle-kit
 * generate` → the drizzle/ folders, bundled into drizzle-manifest.generated.ts);
 * this module APPLIES them at boot using drizzle-orm's OWN bun:sqlite migrator on
 * the store's connection. We adopt drizzle's transaction model (all pending
 * migrations in one transaction) deliberately — a purpose-built tool's model over
 * ours. The operational envelope drizzle doesn't provide is kept here: the
 * pre-migration backup (#43), a downgrade guard, and boot logging.
 *
 * The legacy hand-rolled chain (002…session-geometry.ts + its runner) is GONE.
 * The two founders' databases were the only ones in existence and both were at
 * the final legacy schema, so instead of healing we STAMP: an existing database
 * at exactly BASELINE_LEGACY_VERSION has the frozen baseline recorded as applied
 * (never executed); one behind it is refused (loudly — there is no chain left to
 * catch it up); a fresh database is built by the baseline. `migrateDatabase` is
 * the single entry point.
 */

import { bunSqliteClient, type SqlDatabase } from '@podium/runtime/sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { backupDatabase } from './backup'
import { BASELINE_MIGRATION, DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

/**
 * One drizzle migration, bundled in memory (no disk read at runtime — the
 * compiled binary carries no drizzle/ folder). `name` is the migration folder
 * name (e.g. `20260715135845_baseline`); `sql` is the full `migration.sql`
 * (statements separated by drizzle's `--> statement-breakpoint`).
 */
export interface DrizzleMigration {
  name: string
  sql: string
}

/** drizzle's default migrations ledger. */
const LEDGER = '__drizzle_migrations'

/**
 * The final legacy `schema_version` at drizzle adoption — the point the frozen
 * baseline captures (migration `20260715094750` session-geometry). A pre-drizzle
 * database MUST be exactly here before the baseline is stamped; behind it we
 * refuse, because the legacy chain that would heal it no longer exists.
 */
export const BASELINE_LEGACY_VERSION = 20_260_715_094_750

function hasTable(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

/** drizzle's v1 `__drizzle_migrations` shape, created verbatim so its CLI agrees. */
function ensureLedger(db: SqlDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       id INTEGER PRIMARY KEY,
       hash text NOT NULL,
       created_at numeric,
       name text,
       applied_at TEXT
     )`,
  )
}

/**
 * The set of migration folder-names this DB has applied. drizzle skips by NAME,
 * so the apply decision is pure set membership — an out-of-order migration simply
 * applies, and nothing is skipped because a higher name is present.
 */
export function appliedDrizzleNames(db: SqlDatabase): Set<string> {
  if (!hasTable(db, LEDGER)) return new Set()
  const rows = db.prepare(`SELECT name FROM ${LEDGER} WHERE name IS NOT NULL`).all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

/**
 * drizzle's `created_at`: the folder-name's 14-digit `YYYYMMDDHHMMSS` UTC prefix
 * as epoch millis, matching what the bun:sqlite migrator records for the same
 * migration so a hand-stamped baseline is indistinguishable from an applied one.
 */
function folderMillis(name: string): number {
  const s = name.slice(0, 14)
  const millis = Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
    Number(s.slice(10, 12)),
    Number(s.slice(12, 14)),
  )
  return Number.isNaN(millis) ? 0 : millis
}

/**
 * Records a migration as applied WITHOUT running its SQL — the adoption bridge
 * for an existing database whose schema the (now-deleted) legacy chain already
 * built. Matches the bun:sqlite migrator's journal-array row (empty hash,
 * `created_at` = folder millis). Returns false if it was already recorded.
 */
export function stampMigration(db: SqlDatabase, m: DrizzleMigration): boolean {
  if (appliedDrizzleNames(db).has(m.name)) return false
  // Atomic: create the ledger AND record the row in one transaction. A crash
  // between the two would otherwise leave an EMPTY `__drizzle_migrations` table,
  // which the next boot would read as "drizzle-native", skip the bridge, and try
  // to RE-RUN the baseline against an already-built schema — an unrecoverable
  // wedge. `migrateDatabase` also treats an empty ledger as not-yet-adopted, so
  // even a hand-created empty ledger self-heals; this keeps the transient state
  // from ever existing.
  db.exec('BEGIN IMMEDIATE')
  try {
    ensureLedger(db)
    db.prepare(
      `INSERT INTO ${LEDGER} (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)`,
    ).run('', folderMillis(m.name), m.name, new Date().toISOString())
    db.exec('COMMIT')
  } catch (err) {
    // A failed COMMIT may have already auto-rolled-back (e.g. an I/O error), so a
    // bare ROLLBACK could throw "no transaction is active" and mask the real
    // cause. Best-effort rollback, then always surface the original error.
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw err
  }
  return true
}

/** MAX(schema_version) of the legacy ledger, or undefined when it is absent. */
function legacySchemaVersion(db: SqlDatabase): number | undefined {
  if (!hasTable(db, 'schema_version')) return undefined
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

/** True when the DB holds any table other than the two ledgers / sqlite internals. */
function hasAnyDataTable(db: SqlDatabase): boolean {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name NOT IN ('${LEDGER}', 'schema_version')
             AND name NOT LIKE 'sqlite_%'
           LIMIT 1`,
      )
      .get() !== undefined
  )
}

/**
 * Applies all unapplied migrations via drizzle-orm's bun:sqlite migrator on the
 * store's own connection (so the boot-time `PRAGMA foreign_keys = OFF` window
 * covers it). Returns the names applied in this run. Throws — without touching
 * the schema — when the DB has applied a migration this build does not define
 * (downgrade protection).
 */
export function runDrizzleMigrations(
  db: SqlDatabase,
  migrations: DrizzleMigration[],
  opts: { dbPath?: string } = {},
): string[] {
  const applied = appliedDrizzleNames(db)

  const known = new Set(migrations.map((m) => m.name))
  for (const name of applied) {
    if (!known.has(name)) {
      throw new Error(
        `database has applied migration '${name}', which this build does not define. ` +
          `The database is newer than this build — upgrade the Podium server ` +
          `(downgrades are not supported).`,
      )
    }
  }

  // Apply in folder-name order, and hand drizzle the SAME order: its array path
  // applies in array order (it filters by name but never sorts), so a sorted
  // input keeps the reported/applied order in lockstep even if a caller passes
  // an unsorted list.
  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name))
  const pending = ordered.filter((m) => !applied.has(m.name))
  if (pending.length === 0) return []

  // #43: snapshot before applying anything, but only when the DB already holds
  // real tables (a brand-new file is not worth backing up).
  if (opts.dbPath !== undefined && opts.dbPath !== ':memory:' && hasAnyDataTable(db)) {
    backupDatabase(db, opts.dbPath, `drizzle-${applied.size}`)
  }

  const client = bunSqliteClient(db)
  if (client === undefined) {
    throw new Error(
      'the drizzle migrator requires the bun:sqlite runtime — Podium runs under Bun ' +
        '(the production binary and the vitest suite via `bun --bun`).',
    )
  }
  // drizzle applies the by-name-unapplied set in one transaction and writes the
  // ledger; it skips already-applied names, so passing the full ordered list is
  // correct.
  migrate(
    drizzle({ client }),
    ordered.map((m) => ({ name: m.name, timestamp: folderMillis(m.name), sql: m.sql })),
  )
  return pending.map((m) => m.name)
}

/**
 * The boot entry point. Bridges a pre-drizzle database onto the ledger, then
 * applies pending migrations. Keyed on whether the drizzle ledger has any
 * applied migration (an EMPTY `__drizzle_migrations` — e.g. left by a crashed
 * first adoption — counts as not-yet-adopted, so it self-heals rather than
 * skipping the bridge and re-running the baseline):
 *  - ledger has applied rows → already drizzle-native; just apply pending.
 *  - `schema_version` at exactly BASELINE_LEGACY_VERSION → stamp the baseline
 *    (its DDL is already present), then apply anything past it.
 *  - `schema_version` BEHIND that → refuse: the legacy chain is gone.
 *  - `schema_version` AHEAD → refuse (downgrade).
 *  - data tables but no ledger at all → refuse (unrecognized).
 *  - empty file → the baseline builds the schema.
 */
export function migrateDatabase(
  db: SqlDatabase,
  migrations: DrizzleMigration[],
  baseline: DrizzleMigration,
  opts: { dbPath?: string } = {},
): string[] {
  if (appliedDrizzleNames(db).size === 0) {
    const legacy = legacySchemaVersion(db)
    if (legacy !== undefined) {
      if (legacy < BASELINE_LEGACY_VERSION) {
        throw new Error(
          `database is at legacy schema_version ${legacy}, but this build adopted drizzle at ` +
            `${BASELINE_LEGACY_VERSION} and no longer carries the legacy migration chain. ` +
            `Run the last pre-drizzle Podium build once to migrate this database to ` +
            `${BASELINE_LEGACY_VERSION}, then upgrade again.`,
        )
      }
      if (legacy > BASELINE_LEGACY_VERSION) {
        throw new Error(
          `database schema_version ${legacy} is newer than this build's baseline ` +
            `(${BASELINE_LEGACY_VERSION}). Upgrade the Podium server — downgrades are not supported.`,
        )
      }
      // Exactly at the baseline: record it as applied without re-running its DDL.
      // Log it — this one-time adoption stamp is the riskiest schema event, and
      // an invisible schema change is exactly what #472 taught us to avoid.
      if (stampMigration(db, baseline)) {
        console.log(
          `[podium:server] adopted existing database onto drizzle — stamped baseline ${baseline.name}`,
        )
      }
    } else if (hasAnyDataTable(db)) {
      throw new Error(
        `database has tables but neither a drizzle nor a legacy migration ledger — ` +
          `unrecognized state, refusing to migrate it automatically.`,
      )
    }
    // else: empty file → the baseline is applied below and builds the schema.
  }
  return runDrizzleMigrations(db, migrations, opts)
}

/**
 * Builds the full current schema on a fresh database from the bundled baseline —
 * for tests and tools that need the schema in isolation, without constructing the
 * whole SessionStore (the drizzle equivalent of the old `runMigrations(db,
 * MIGRATIONS)`). Requires the bun:sqlite runtime, like the migrator itself.
 */
export function applyBaselineSchema(db: SqlDatabase): string[] {
  return migrateDatabase(db, DRIZZLE_MIGRATIONS, BASELINE_MIGRATION)
}

export { backupDatabase } from './backup'
