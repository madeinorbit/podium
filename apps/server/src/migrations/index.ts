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

import { bunSqliteClient, isBunRuntime, type SqlDatabase } from '@podium/runtime/sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { backupDatabase } from './backup'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { applySchemaRepairs, repairReason } from './repair'

/**
 * The `client` slot of drizzle's bun-sqlite config — bun:sqlite's real `Database`
 * class. Named off drizzle's own signature rather than imported from `bun:sqlite`,
 * which is unresolvable in any program without @types/bun (this one included).
 */
type DrizzleBunClient = Extract<Parameters<typeof drizzle>[0], { client: unknown }>['client']

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
 * Migration identities that were deployed locally before the same change was
 * rebased upstream under a different generated timestamp. An alias is accepted
 * only while its canonical migration is present in the supplied build, so the
 * downgrade guard remains strict for every other unknown ledger entry.
 */
const MIGRATION_NAME_ALIASES = new Map<string, string>([
  ['20260722210552_session-spawn-failure', '20260724134702_session-spawn-failure'],
])

/**
 * THE OUT-OF-ORDER GUARD [POD-1621]. Names every pending migration that sorts
 * BEFORE the highest already-applied name — the exact signature of a second
 * lineage arriving late.
 *
 * Out-of-order on its own is harmless: two branches generate timestamps
 * independently and merge, and most such migrations are additive. It becomes the
 * POD-1621 hazard when the late migration REBUILDS a table (SQLite's
 * create/copy/drop/rename pattern), because its column list was written without
 * knowledge of anything the other lineage added. The ledger cannot see the loss:
 * every migration ran exactly once.
 *
 * So the signature is worth surfacing on its own, before knowing whether damage
 * followed — it is cheap, it is exact, and a boot log naming it turns "auth has
 * been throwing for hours" into a five-minute diagnosis.
 */
export function outOfOrderPending(
  appliedNames: Iterable<string>,
  pendingNames: readonly string[],
): string[] {
  const highestApplied = [...appliedNames].sort((a, b) => a.localeCompare(b)).at(-1)
  if (highestApplied === undefined) return []
  return pendingNames.filter((name) => name.localeCompare(highestApplied) < 0)
}

function hasTable(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

/**
 * The set of migration folder-names this DB has applied. drizzle skips by NAME,
 * so the apply decision is pure set membership — an out-of-order migration simply
 * applies, and nothing is skipped because a higher name is present. That is what
 * `outOfOrderPending` exists to make visible.
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
 *
 * Two POD-1621 additions bracket the apply. BEFORE: `outOfOrderPending` warns
 * when a pending migration sorts earlier than one already applied. AFTER (and
 * also when nothing is pending, which is the damaged database's own shape):
 * `applySchemaRepairs` restores columns a past out-of-order rebuild dropped.
 *
 * The guard WARNS rather than refuses, deliberately. Refusing would have blocked
 * the very landing that exposed this, and would block every honest merge of two
 * branches whose timestamps interleave — a common, usually harmless event with
 * no safe self-service recovery, which turns one bad boot into a fleet that
 * cannot start. Warning plus an automatic repair leaves the failure mode as
 * "upgrade proceeds, damage is named in the log and healed", which is strictly
 * better than tonight's "upgrade proceeds, damage is silent".
 *
 * `skipSchemaRepair` exists for ONE caller: the reproduction test, which has to
 * be able to construct the genuinely damaged database. Production never sets it.
 */
export function runDrizzleMigrations(
  db: SqlDatabase,
  migrations: DrizzleMigration[],
  opts: { dbPath?: string; skipSchemaRepair?: boolean } = {},
): string[] {
  const applied = appliedDrizzleNames(db)

  const known = new Set(migrations.map((m) => m.name))
  for (const [alias, canonical] of MIGRATION_NAME_ALIASES) {
    if (known.has(canonical)) known.add(alias)
  }
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
  const semanticallyApplied = new Set(
    [...applied].map((name) => MIGRATION_NAME_ALIASES.get(name) ?? name),
  )
  const pending = ordered.filter((m) => !semanticallyApplied.has(m.name))

  // THE GUARD, before anything is applied — so the warning is in the log ABOVE
  // the damage rather than after it. It WARNS and proceeds; it does not refuse.
  // See this function's doc comment and the commit message for why.
  const outOfOrder = outOfOrderPending(
    applied,
    pending.map((m) => m.name),
  )
  if (outOfOrder.length > 0) {
    console.warn(
      `[podium:server] out-of-order migrations: ${outOfOrder.join(', ')} sort BEFORE ` +
        `migrations this database has already applied. They will be applied now. ` +
        `If any of them REBUILDS a table (CREATE __new_x / INSERT SELECT / DROP / RENAME), ` +
        `it can silently drop columns added by the other lineage — the ledger will still ` +
        `read as complete. Verify the schema of any table they rebuild [POD-1621].`,
    )
  }

  if (pending.length === 0) {
    // Still repair: the POD-1621 database has EVERY migration applied and a
    // wrong schema, so a boot with nothing pending is exactly the case that
    // must heal itself.
    if (opts.skipSchemaRepair !== true) reportRepairs(db)
    return []
  }

  // #43: snapshot before applying anything, but only when the DB already holds
  // real tables (a brand-new file is not worth backing up).
  if (opts.dbPath !== undefined && opts.dbPath !== ':memory:' && hasAnyDataTable(db)) {
    backupDatabase(db, opts.dbPath, `drizzle-${applied.size}`)
  }

  const client = bunSqliteClient(db)
  if (client === undefined) {
    // Two very different causes, and guessing between them costs hours — so ask the
    // runtime which one it is rather than blaming bun for both [POD-746]. Under bun,
    // an unrecognised handle means `db` was registered in ANOTHER copy of
    // @podium/runtime's WeakMap: the package got loaded twice (a lane resolving it
    // outside this checkout), so this copy has never seen it.
    throw new Error(
      isBunRuntime()
        ? 'the drizzle migrator does not recognise this database handle. It runs on bun:sqlite ' +
            'and this IS bun, so the handle was opened by a different copy of @podium/runtime ' +
            '(the package is loaded twice — check how the lane resolves it), or by something ' +
            'other than openDatabase().'
        : 'the drizzle migrator requires the bun:sqlite runtime — Podium runs under Bun ' +
            '(the production binary and the vitest suite via `bun --bun`).',
    )
  }
  // drizzle applies this already-filtered pending set in one transaction and
  // writes the ledger. Passing only pending migrations is essential for aliases:
  // drizzle cannot know that an old ledger name already performed the canonical
  // migration SQL, and replaying it could add the same column twice.
  migrate(
    // `client` is @podium/runtime's deliberately narrow structural view of the
    // bun:sqlite handle (packages/runtime/src/sqlite/bun.ts names only the methods
    // we call, so that module stays importable under Node). drizzle's `client` slot
    // names bun:sqlite's real `Database` class, which materializes only in a program
    // that loads @types/bun — this file's own lane resolves `bun:sqlite` to `any`,
    // the scripts typecheck lane does not (POD-1122). Same object at runtime.
    drizzle({ client: client as unknown as DrizzleBunClient }),
    pending.map((m) => ({ name: m.name, timestamp: folderMillis(m.name), sql: m.sql })),
  )
  // AFTER the migrations, never before: the rebuild that drops the column is
  // itself one of the migrations that may have just run.
  if (opts.skipSchemaRepair !== true) reportRepairs(db)
  return pending.map((m) => m.name)
}

/** Repairs known schema drift and says so — loudly, and only when it acted. */
function reportRepairs(db: SqlDatabase): void {
  for (const id of applySchemaRepairs(db)) {
    console.warn(`[podium:server] repaired missing column ${id} — ${repairReason(id)}`)
  }
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
export { applySchemaRepairs } from './repair'
/** The other half of the backup story (ADR 2 D1): restore copies the file back
 *  AND re-mints the feed epoch in one step, so a rolled-back authority can never
 *  serve a cursor from the timeline it just abandoned. */
export { type RestoreReport, restoreCliMain, restoreDatabase } from './restore'
