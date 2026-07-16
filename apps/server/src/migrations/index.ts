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
 * The legacy hand-rolled chain AND the one-time adoption bridge are gone: every
 * database is drizzle-native (has the `__drizzle_migrations` ledger). A fresh
 * file is built by the baseline; an existing drizzle DB applies whatever is
 * pending. (A database still carrying only the old `schema_version` ledger must
 * be stamped once by the drizzle-adoption build 938ad5bd before this build will
 * open it — that transition is complete for the founders' databases.)
 */

import { bunSqliteClient, type SqlDatabase } from '@podium/runtime/sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { backupDatabase } from './backup'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

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

function hasTable(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
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
 * migration.
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

/** True when the DB holds any table other than the ledger / sqlite internals. */
function hasAnyDataTable(db: SqlDatabase): boolean {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name != '${LEDGER}'
             AND name NOT LIKE 'sqlite_%'
           LIMIT 1`,
      )
      .get() !== undefined
  )
}

/**
 * The boot entry point: applies all unapplied migrations via drizzle-orm's
 * bun:sqlite migrator on the store's own connection (so the boot-time
 * `PRAGMA foreign_keys = OFF` window covers it). A fresh file is built by the
 * baseline; an existing drizzle database advances by any pending migrations.
 * Returns the names applied in this run. Throws — without touching the schema —
 * when the DB has applied a migration this build does not define (downgrade
 * protection).
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
 * Builds the full current schema on a fresh database from the bundled migrations —
 * for tests and tools that need the schema in isolation, without constructing the
 * whole SessionStore. Requires the bun:sqlite runtime, like the migrator itself.
 */
export function applyBaselineSchema(db: SqlDatabase): string[] {
  return runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
}

export { backupDatabase } from './backup'
