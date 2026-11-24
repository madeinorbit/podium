import { bootStage } from '../boot-timing'

/**
 * Schema migration runtime.
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

import { createLogger } from '@podium/logger'
import { type IdPrefix, mintBrandedId } from '@podium/model'
import { parseOperation } from '@podium/protocol'
import { reportLifecycleProgress } from '@podium/runtime/lifecycle-channel'
import { beginMachineUpdateMigrations } from '@podium/runtime/machine-update'
import { MIGRATION_NAME_ALIASES as SHARED_MIGRATION_NAME_ALIASES } from '@podium/runtime/migration-ledger'
import { bunSqliteClient, isBunRuntime, type SqlDatabase } from '@podium/runtime/sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { backupDatabase, freeDiskBytes, measureBackupSpace } from './backup'
import { discardBackupSeed } from './backup-seed'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import {
  folderMillis,
  knownMigrationNames,
  newerDatabaseMessage,
  outOfOrderPending,
  unknownAppliedMigrations,
} from './ledger-guards'
import { applySchemaRepairs, repairReason, schemaRepairsAfter } from './repair'

const log = createLogger('server:migrations')

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
 *
 * ONE HOME, in @podium/runtime: the daemon's convergence gate (POD-2213) reads
 * this same ledger to decide whether a build it is about to swap in could open
 * this database, and two copies of "which entries are the same migration" is
 * how that decision and this one stop agreeing.
 */
const MIGRATION_NAME_ALIASES = SHARED_MIGRATION_NAME_ALIASES

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
 * THE NEWEST MIGRATION IDENTITY THIS DATABASE HAS APPLIED — the exact string a
 * transfer target verifies against its own build (`server-transfer.ts`).
 *
 * Here rather than in the store facade (POD-3246) because the ledger belongs to
 * the migrator: the facade holds no SQL of its own, and a second place that
 * knows the ledger's name and shape is a second opinion about what "this
 * database's schema version" means.
 *
 * `undefined` when the ledger holds nothing — a database that has applied no
 * migration has no identity to transfer, which is a different answer from a
 * failure to read one.
 */
export function latestAppliedMigration(db: SqlDatabase): string | undefined {
  if (!hasTable(db, LEDGER)) return undefined
  const row = db.prepare(`SELECT name FROM ${LEDGER} ORDER BY name DESC LIMIT 1`).get() as
    | { name?: unknown }
    | undefined
  return typeof row?.name === 'string' && row.name.length > 0 ? row.name : undefined
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
  opts: {
    dbPath?: string
    skipSchemaRepair?: boolean
    update?: { runtimeDir: string; grantId: string }
    /** Free bytes on the database's file system; tests plant a small disk. */
    freeBytes?: (dir: string) => number
  } = {},
): string[] {
  const applied = appliedDrizzleNames(db)

  const known = knownMigrationNames(
    migrations.map((m) => m.name),
    MIGRATION_NAME_ALIASES,
  )
  const [unknown] = unknownAppliedMigrations(applied, known)
  if (unknown !== undefined) throw new Error(newerDatabaseMessage(unknown))

  // Apply in folder-name order, and hand drizzle the SAME order: its array path
  // applies in array order (it filters by name but never sorts), so a sorted
  // input keeps the reported/applied order in lockstep even if a caller passes
  // an unsorted list.
  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name))
  const semanticallyApplied = new Set(
    [...applied].map((name) => MIGRATION_NAME_ALIASES.get(name) ?? name),
  )
  // Retirement is a separate boot stage: an old binary upgrades its schema
  // before the identity import can read its credentials and links. Never stamp
  // the deferred migration until that import has committed for this database.
  const imported =
    hasTable(db, 'meta') &&
    db
      .prepare("SELECT 1 FROM meta WHERE key = 'identity.legacyLinksImported' AND value = '1'")
      .get() !== undefined
  const pending = ordered.filter(
    (m) =>
      !semanticallyApplied.has(m.name) &&
      (!m.sql.startsWith('-- after-local-identity-import') || imported),
  )

  // THE GUARD, before anything is applied — so the warning is in the log ABOVE
  // the damage rather than after it. It WARNS and proceeds; it does not refuse.
  // See this function's doc comment and the commit message for why.
  const outOfOrder = outOfOrderPending(
    applied,
    pending.map((m) => m.name),
  )
  if (outOfOrder.length > 0) {
    log.warn(
      'out-of-order migrations sort BEFORE migrations this database has already applied and will be applied now. If any of them REBUILDS a table (CREATE __new_x / INSERT SELECT / DROP / RENAME) it can silently drop columns added by the other lineage — the ledger will still read as complete. Verify the schema of any table they rebuild [POD-1621]',
      { migrations: outOfOrder },
    )
  }

  const filePath = opts.dbPath === ':memory:' ? undefined : opts.dbPath
  if (pending.length === 0) {
    // A seed the old server wrote for a backup this boot does not take (the
    // release carried no migration, or an earlier boot already applied them) is
    // a database-sized file nothing will read (`backup-seed.ts`).
    if (filePath !== undefined) discardBackupSeed(filePath)
    if (opts.skipSchemaRepair !== true) reportRepairs(db)
    return []
  }

  // Snapshot before schema work. A retry with only retirement deferred keeps
  // the original pre-upgrade snapshot instead of ageing it out of retention.
  if (filePath !== undefined && hasAnyDataTable(db)) {
    refuseWithoutFreeSpace(db, filePath, opts.freeBytes ?? freeDiskBytes, opts.update?.grantId)
    const backupStarted = performance.now()
    backupDatabase(db, filePath, `drizzle-${applied.size}`)
    bootStage('backup', backupStarted)
    // The published seed was consumed; this removes what a killed old server left.
    discardBackupSeed(filePath)
  } else if (filePath !== undefined) {
    discardBackupSeed(filePath)
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
  // This is also the parent's rollback witness:
  // <state>/runtime/machine-update-migrations/<sha256(grantId)>.json.
  // Record the intent BEFORE SQLite, then committed IDs BEFORE repairs/logging.
  const record =
    opts.update && opts.dbPath && opts.dbPath !== ':memory:'
      ? beginMachineUpdateMigrations(
          opts.update.runtimeDir,
          opts.update.grantId,
          opts.dbPath,
          pending.map((m) => m.name),
        )
      : undefined
  try {
    // A previously damaged database must heal before pending migrations index
    // the missing column. A rebuild still pending is repaired in the same
    // transaction below, immediately after the statement that drops it.
    if (opts.skipSchemaRepair !== true) reportRepairs(db)
    migrate(
      // `client` is @podium/runtime's deliberately narrow structural view of the
      // bun:sqlite handle (packages/runtime/src/sqlite/bun.ts names only the methods
      // we call, so that module stays importable under Node). drizzle's `client` slot
      // names bun:sqlite's real `Database` class, which materializes only in a program
      // that loads @types/bun — this file's own lane resolves `bun:sqlite` to `any`,
      // the scripts typecheck lane does not (POD-1122). Same object at runtime.
      drizzle({
        // Progress for an upgrade only: a fresh database builds from the whole chain at once.
        client: reportingRebuilds(
          client,
          applied.size > 0 ? pending : [],
        ) as unknown as DrizzleBunClient,
      }),
      pending.map((m) => ({
        name: m.name,
        timestamp: folderMillis(m.name),
        // Capture install age BEFORE this batch: historical migrations create
        // a first admin even on an empty database. The backfill must leave
        // that new account eligible while seeding every account on upgrades.
        sql: mintIdsIn(
          [
            m.sql,
            ...(opts.skipSchemaRepair === true ? [] : schemaRepairsAfter(m.name, applied)),
          ].join('\n--> statement-breakpoint\n'),
        ).replaceAll('{{existing-install}}', applied.size > 0 ? '1' : '0'),
      })),
    )
  } catch (error) {
    // Drizzle rolls back the entire batch. Do not name attempted SQL as applied.
    record?.([])
    throw error
  }
  record?.(pending.map((m) => m.name))
  if (pending.some((m) => m.name === '20260917185720_session-delegation-record')) {
    const row = db
      .prepare('SELECT count(*) AS count FROM sessions WHERE delegation IS NULL')
      .get() as { count: number }
    if (row.count > 0)
      log.warn('legacy sessions lack authoritative delegation; explicit authorization required', {
        count: row.count,
      })
  }
  // AFTER the migrations, never before: the rebuild that drops the column is
  // itself one of the migrations that may have just run.
  if (opts.skipSchemaRepair !== true) reportRepairs(db)
  return pending.map((m) => m.name)
}

/**
 * THE UPGRADE NEEDS ROOM (POD-6959 design 2.6, POD-7024). Before the backup, refuse when the
 * file system holding the database has less free space than {@link UPGRADE_SPACE_FACTOR} times
 * its size. The backup is a full copy; the migrations' one transaction writes about the data
 * again into the WAL while it rebuilds tables (the keys migration rebuilds nearly all of them);
 * and the file grows by about its largest table, whose new copy cannot reuse the old one's
 * pages. Measured on a 1.83 GB database with no free pages, the keys migration peaked at 2.2
 * times the database beside it (backup 1.0, WAL 0.9, growth 0.3). Refusing here changes
 * nothing; running out of space halfway through would roll the whole batch back after minutes
 * of work, with a backup beside it.
 */
export const UPGRADE_SPACE_FACTOR = 2.5

function refuseWithoutFreeSpace(
  db: SqlDatabase,
  dbPath: string,
  freeBytes: (dir: string) => number,
  installedGrantId?: string,
): void {
  // The backup's own measure (database and sidecars, `migrations/backup.ts`), so the two
  // checks read one number; the backup itself still asks for its copy with a margin.
  const space = measureBackupSpace(dbPath, freeBytes)
  const required = Math.ceil(UPGRADE_SPACE_FACTOR * space.needed)
  if (space.available + space.reusable >= required) return
  log.warn('refusing the upgrade: not enough free disk space', { dbPath, ...space })
  const reason =
    `Podium cannot upgrade its database: there is not enough free disk space. The upgrade ` +
    `needs about ${megabytes(required)} free in ${space.dir} (a backup copy and ` +
    `room to rewrite the tables), and ${megabytes(space.available)} is free. Free some ` +
    `space and start Podium again. Nothing was changed.`
  preserveUpgradeRefusal(db, installedGrantId, reason)
  throw new Error(reason)
}

// LEGACY(remove-after: 2027-06): predecessors overwrite a boot refusal on rollback; preserve the installed grant's operation before exiting.
function preserveUpgradeRefusal(
  db: SqlDatabase,
  installedGrantId: string | undefined,
  reason: string,
): void {
  if (!installedGrantId || !hasTable(db, 'operations')) return
  try {
    // This runs before schema migration, without repositories or sync triggers.
    // Old installs have no workspace column; newer ones must stay in the local workspace.
    const scoped = (db.prepare('PRAGMA table_info(operations)').all() as { name: string }[]).some(
      (column) => column.name === 'workspace_id',
    )
    const scope = scoped ? ' AND workspace_id = ?' : ''
    const bindings = scoped ? [SELF_HOSTED_WORKSPACE_ID] : []
    const row = db
      .prepare(
        `SELECT id, payload FROM operations WHERE kind = 'update' AND exclusion_group = 'lifecycle' AND state = 'running'${scope} LIMIT 1`,
      )
      .get(...bindings) as { id: string; payload: string } | undefined
    if (!row) return
    const operation = parseOperation(JSON.parse(row.payload))
    if (
      operation?.id !== row.id ||
      operation.kind !== 'update' ||
      operation.state !== 'running' ||
      operation.details?.coordinatorSnapshotGrantId !== installedGrantId
    )
      return
    const now = Date.now()
    const error = { code: 'handover-failed', message: reason }
    operation.state = 'failed'
    operation.updatedAt = operation.finishedAt = now
    operation.error = error
    // Predecessors use either a server step or one fleet-wide machines step.
    // The exact installed grant is the binding, not that step's presentation.
    for (const step of operation.steps ?? []) {
      if (step.state !== 'running' && step.state !== 'stalled') continue
      step.state = 'failed'
      step.finishedAt = step.lastProgressAt = now
      step.error = error
    }
    // Compare the envelope too: never replace a concurrently changed operation.
    db.prepare(
      `UPDATE operations SET state = 'failed', updated_at = ?, finished_at = ?, payload = ? WHERE id = ? AND payload = ? AND state = 'running'${scope}`,
    ).run(now, now, JSON.stringify(operation), row.id, row.payload, ...bindings)
  } catch (error) {
    // Failure to retain the UI error must never hide the original boot refusal.
    log.warn('could not preserve the upgrade disk refusal', { err: error })
  }
}

const megabytes = (bytes: number): string => `${Math.ceil(bytes / 1_000_000)} MB`

/** An index statement: drizzle-kit writes a rebuild migration's indexes after its tables. */
const INDEX_STATEMENT = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s/i

/** A table rebuild's last step: drizzle-kit's `ALTER TABLE __new_x RENAME TO x`. */
const REBUILD_DONE = /^\s*ALTER TABLE [`"]__new_(\w+)[`"] RENAME TO /i
const REBUILD_START = /CREATE TABLE [`"]__new_\w+[`"]/gi

/**
 * ONE PROGRESS LINE PER REBUILT TABLE (POD-6959 design 2.6, P-OD1). A rebuild migration holds
 * the boot for as long as copying its tables takes, minutes on a large install, so the log says
 * how far it is. The migrator prepares each statement through the client's `query`, so the
 * client handed to drizzle is watched for the rename that ends each rebuild; the copy before it
 * has run by then. Nothing is watched when no pending migration rebuilds a table.
 */
function reportingRebuilds<TClient extends object>(
  client: TClient,
  pending: readonly DrizzleMigration[],
): TClient {
  const total = pending.reduce((sum, m) => sum + (m.sql.match(REBUILD_START)?.length ?? 0), 0)
  if (pending.length === 0) return client
  let done = 0
  let last = performance.now()
  // drizzle-kit writes the indexes of every rebuilt table after the rebuilds: one line says
  // how long they took, so the time is not counted against the table rebuilt next.
  let indexes = 0
  let indexSteps = 0
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') return value
      if (property !== 'query') return value.bind(target)
      return (sql: string, ...rest: unknown[]) => {
        if (INDEX_STATEMENT.test(sql)) {
          indexes += 1
          reportLifecycleProgress(`migration index ${++indexSteps}`)
        } else if (indexes > 0) {
          const now = performance.now()
          log.info('built indexes', { count: indexes, ms: Math.round(now - last) })
          last = now
          indexes = 0
        }
        const rebuilt = REBUILD_DONE.exec(sql)?.[1]
        if (rebuilt !== undefined) {
          done += 1
          const now = performance.now()
          log.info('rebuilt table', {
            table: rebuilt,
            done,
            of: total,
            ms: Math.round(now - last),
          })
          reportLifecycleProgress(`migration table ${done}/${total}: ${rebuilt}`)
          last = now
        }
        return value.call(target, sql, ...rest)
      }
    },
  })
}

/**
 * `{{mint:<prefix>_}}` — A MIGRATION ASKING FOR A FRESHLY MINTED ID [A2].
 *
 * WHAT NEEDED THIS. A2 gives the existing first member an ordinary `mem_` id,
 * and "ordinary" is the requirement: one id per installation, minted, not a
 * second constant with a nicer prefix. SQL cannot mint one — a KSUID is four
 * bytes of clock and sixteen of randomness rendered in base62, which in SQLite
 * is long division over a 160-bit number written as a recursive CTE, frozen into
 * a migration forever and testable only against itself. This is the same
 * problem `20260730173834_user-accounts-first-admin` hit with a file it could
 * not read, and the same answer: let the process do the part SQL cannot, at the
 * moment the migration is applied.
 *
 * ONE ID PER PREFIX PER MIGRATION, because the A2 migration spells the new id in
 * every UPDATE it makes and they must all name the same member. Substitution is
 * therefore by prefix, not by occurrence.
 *
 * INVISIBLE TO THE LEDGER. drizzle's array form records a migration by NAME with
 * an empty hash, so two installations applying this migration with two different
 * ids are indistinguishable to the skip logic and to the downgrade guard — which
 * is what makes a per-apply substitution safe here and would not be safe against
 * a migrator that checksums its SQL.
 *
 * A migration with no token is returned unchanged, which is every migration but
 * one.
 */
export function mintIdsIn(sql: string, mint: (prefix: IdPrefix) => string = mintBrandedId): string {
  const minted = new Map<string, string>()
  return sql.replace(/\{\{mint:([a-z]{2,4}_)\}\}/g, (_match, prefix: string) => {
    const existing = minted.get(prefix)
    if (existing !== undefined) return existing
    const fresh = mint(prefix as IdPrefix)
    minted.set(prefix, fresh)
    return fresh
  })
}

/** Repairs known schema drift and says so — loudly, and only when it acted. */
function reportRepairs(db: SqlDatabase): void {
  for (const id of applySchemaRepairs(db)) {
    log.warn('repaired a missing column', { column: id, reason: repairReason(id) })
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
export { outOfOrderPending } from './ledger-guards'
export { applySchemaRepairs } from './repair'
/** The other half of the backup story (ADR 2 D1): restore copies the file back
 *  AND re-mints the feed epoch in one step, so a rolled-back authority can never
 *  serve a cursor from the timeline it just abandoned. */
export { type RestoreReport, restoreCliMain, restoreDatabase } from './restore'
