/**
 * Forward-only schema migration runner.
 *
 * The migration chain OWNS the schema (Phase 1): a fresh database is built
 * entirely by the numbered migrations below, and an existing database (legacy
 * DDL path, stamped baseline 1) converges onto the identical schema through
 * migration 002's defensive guards. convergence.test.ts pins that both paths
 * produce byte-identical sqlite_master output. The only schema objects NOT
 * versioned here are the environment-conditional FTS5 tables/triggers — the
 * conversations repository (re)ensures those per boot, because their existence
 * depends on the runtime SQLite build.
 *
 * ADDING A MIGRATION — run `bun run migration:new <name>`. Never hand-pick a number.
 *
 * Rules (POLICY — read before adding a migration):
 *  - NEW MIGRATIONS ARE VERSIONED BY UTC TIMESTAMP (YYYYMMDDHHMMSS), not MAX+1
 *    (#485). Hand-assigned sequential numbers GUARANTEE collisions at our
 *    concurrency: agents work on parallel branches, each takes the next integer,
 *    and they only discover the clash at merge. A timestamp cannot collide — there
 *    is nothing to coordinate and no conflict to notice. (Rails made this exact
 *    switch in 2.1, for this exact reason.) Versions 1–23 are the historical
 *    sequential ones and stay as they are; the two kinds coexist fine, since a
 *    timestamp is just a very large integer that sorts after them forever.
 *    `validate()` REJECTS a new sequential version at the first test run.
 *  - Migrations are forward-only and ADDITIVE-ONLY: no destructive
 *    column drops or renames within a single release. When a column/table must
 *    go away, do it two-phase: release N stops reading/writing it, release N+1
 *    drops it — so a rollback of one release never faces a schema it cannot read.
 *  - Each migration runs in its OWN top-level transaction, its schema_version
 *    stamp committing atomically alongside the schema change [spec:SP-3fe2].
 *  - A database whose version is NEWER than the code refuses to open with a
 *    clear error (downgrade protection) — the stored version is authoritative.
 *  - Before a run that advances the version of a database that already holds
 *    real tables, the DB file (+ -wal/-shm sidecars) is copied to a timestamped
 *    backup next to it; the last 3 backups are kept (#43).
 *  - Re-running is idempotent: already-applied versions are skipped.
 *  - PENDING IS THE UNAPPLIED SET, NOT "ABOVE THE HIGH-WATER MARK" (#472). A
 *    migration is applied iff its version is absent from `schema_version`. The
 *    runner used to compare against MAX(version), so a migration numbered at or
 *    below the highest applied one was SILENTLY SKIPPED — no error, its tables
 *    simply never created. That is invisible in tests, because every test starts
 *    from an EMPTY database (version 0) and therefore applies everything in order;
 *    only a real, already-upgraded database can exhibit it.
 *  - CLAIMING A NUMBER TWICE IS FATAL, BY DESIGN. If two branches both author a
 *    migration N, the database that applied one of them refuses to boot with an
 *    explicit "duplicate migration version N — renumber" error, rather than
 *    quietly running without the other's tables.
 *  - CONSEQUENCE — MIGRATIONS MUST BE ORDER-INDEPENDENT. Because a back-filled
 *    migration (numbered below the high-water mark) now really does run, a
 *    migration may execute AFTER ones with higher numbers. Ours are effectively
 *    independent, so this is safe today. If you write one that depends on a
 *    lower-numbered migration having already run, that assumption is no longer
 *    guaranteed — make the dependency explicit inside the migration (defensive
 *    guards, as 002 does) rather than relying on ordering.
 */

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { up as coreSchema } from './002-core-schema'
import { up as hardeningIndexes } from './003-hardening-indexes'
import { up as issuesUniqueRepoSeq } from './004-issues-unique-repo-seq'
import { up as issuesRepoIdIdentity } from './005-issues-repo-id-identity'
import { up as issuesFksChecks } from './006-issues-fks-checks'
import { up as issueDepsSingleParent } from './007-issue-deps-single-parent'
import { up as issuesRepoIdIndex } from './008-issues-repo-id-index'
import { up as issuesAudience } from './009-issues-audience'
import { up as issuesDropVerifyingStage } from './010-issues-drop-verifying-stage'
import { up as issueSessionSoftDelete } from './011-issues-soft-delete'
import { up as approvalRequests } from './012-approval-requests'
import { up as locks } from './013-locks'
import { up as machinesInventory } from './014-machines-inventory'
import { up as superagentPendingTurns } from './015-superagent-pending-turns'
import { up as messages } from './016-messages'
import { up as messagesAxes } from './017-messages-axes'
import { up as messagesReminded } from './018-messages-reminded'
import { up as sessionsWorkflowMetadata } from './019-sessions-workflow-metadata'
import { up as recapWatermarks } from './020-recap-watermarks'
import { up as messagesRepairFromIssue } from './021-messages-repair-from-issue'
import { up as agentWorkflows } from './022-agent-workflows'
import { up as accounts } from './023-accounts'
import { up as automations } from './20260714142927-automations'

export interface Migration {
  /** Positive, unique, strictly increasing across the list. */
  version: number
  /** Short human-readable label recorded in schema_version. */
  name: string
  /** Applies the schema change. Runs inside a transaction — do not BEGIN/COMMIT. */
  up: (db: SqlDatabase) => void
}

/** The server's migration list. Append only — never renumber or edit applied entries. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline',
    // No-op marker: databases built by the legacy SessionStore.migrate() DDL
    // stamped version 1 with no structural change; 002 owns the real DDL.
    up: () => {},
  },
  { version: 2, name: 'core-schema', up: coreSchema },
  { version: 3, name: 'hardening-indexes', up: hardeningIndexes },
  { version: 4, name: 'issues-unique-repo-seq', up: issuesUniqueRepoSeq },
  { version: 5, name: 'issues-repo-id-identity', up: issuesRepoIdIdentity },
  { version: 6, name: 'issues-fks-checks', up: issuesFksChecks },
  { version: 7, name: 'issue-deps-single-parent', up: issueDepsSingleParent },
  { version: 8, name: 'issues-repo-id-index', up: issuesRepoIdIndex },
  { version: 9, name: 'issues-audience', up: issuesAudience },
  { version: 10, name: 'issues-drop-verifying-stage', up: issuesDropVerifyingStage },
  { version: 11, name: 'issue-session-soft-delete', up: issueSessionSoftDelete },
  { version: 12, name: 'approval-requests', up: approvalRequests },
  // Advisory named lease locks [spec:SP-85d1] — podium lock / merge-lock.
  { version: 13, name: 'locks', up: locks },
  { version: 14, name: 'machines-inventory', up: machinesInventory },
  { version: 15, name: 'superagent-pending-turns', up: superagentPendingTurns },
  // Unified agent messaging (#237) [spec:SP-34d7].
  { version: 16, name: 'messages', up: messages },
  { version: 17, name: 'messages-axes', up: messagesAxes },
  { version: 18, name: 'messages-reminded', up: messagesReminded },
  { version: 19, name: 'sessions-workflow-metadata', up: sessionsWorkflowMetadata },
  // Read toolkit tier 3 (#237) [spec:SP-34d7 read-toolkit]: recap watermarks.
  { version: 20, name: 'recap-watermarks', up: recapWatermarks },
  // Repair legacy ref-string senders 016 copied verbatim (#463) [spec:SP-34d7].
  { version: 21, name: 'messages-repair-from-issue', up: messagesRepairFromIssue },
  { version: 22, name: 'agent-workflows', up: agentWorkflows },
  // Managed accounts [spec:SP-6454] — credentials Podium holds and injects at
  // spawn. 023, not 016: the runner skips any version <= MAX(applied) (#472).
  { version: 23, name: 'accounts', up: accounts },
  // Scheduled automations + their run history (#470) [spec:SP-17db]. The first
  // timestamp-versioned migration (#485): this branch hand-numbered it twice while
  // in flight — 022, then 023 — and main took both numbers out from under it, which
  // is precisely the collision timestamps abolish.
  { version: 20_260_714_142_927, name: 'automations', up: automations },
]

/** Highest schema version the running code knows about.
 *
 *  MAX, not "the last array entry": the registry is not required to be sorted (#485).
 *  Two branches each append a timestamped migration, and whoever merges second lands
 *  their entry last even if their timestamp is older. */
export function codeSchemaVersion(migrations: Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => (m.version > max ? m.version : max), 0)
}

/** The registry in version order. The array itself may be unsorted — see `validate`. */
function inVersionOrder(migrations: Migration[]): Migration[] {
  return [...migrations].sort((a, b) => a.version - b.version)
}

/**
 * The migrations this database has ACTUALLY applied, version → name.
 *
 * This is the authoritative record and always has been — `schema_version.version`
 * is a PRIMARY KEY. The runner used to ignore it and compare against
 * MAX(version) instead, which is what made a mis-numbered migration silently
 * vanish (#472). Read the set; never infer it from the high-water mark.
 */
export function appliedMigrations(db: SqlDatabase): Map<number, string> {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
    .get()
  if (table === undefined) return new Map()
  const rows = db.prepare('SELECT version, name FROM schema_version').all() as {
    version: number
    name: string
  }[]
  return new Map(rows.map((r) => [r.version, r.name]))
}

/** Current HIGH-WATER version in the database (0 when never migrated).
 *
 *  Only meaningful for the downgrade guard (is this DB newer than the build?).
 *  It is NOT a safe basis for deciding what to apply — see `appliedMigrations`. */
export function dbSchemaVersion(db: SqlDatabase): number {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
    .get()
  if (table === undefined) return 0
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

/**
 * The last hand-numbered sequential migration. Everything at or below this is
 * historical and stays exactly as it is; everything ABOVE must be a timestamp.
 * This is a frozen boundary, not a counter — do not raise it.
 */
export const LAST_SEQUENTIAL_VERSION = 23

/** Smallest accepted timestamp version: 2000-01-01T00:00:00Z. */
const MIN_TIMESTAMP_VERSION = 20_000_101_000_000

/**
 * A UTC timestamp version, `YYYYMMDDHHMMSS` (e.g. 20260714132200).
 *
 * Sequential numbering GUARANTEES collisions at our concurrency: agents work on
 * parallel branches, each takes MAX+1, and they only discover the clash at merge.
 * A timestamp is collision-free by construction — nothing to coordinate, no
 * conflict to notice. (Rails made this same switch in 2.1, for this same reason.)
 * Generate one with `bun run migration:new <name>`; never hand-type it.
 */
export function isTimestampVersion(version: number): boolean {
  if (!Number.isInteger(version) || version < MIN_TIMESTAMP_VERSION) return false
  const s = String(version)
  if (s.length !== 14) return false
  const month = Number(s.slice(4, 6))
  const day = Number(s.slice(6, 8))
  const hour = Number(s.slice(8, 10))
  const minute = Number(s.slice(10, 12))
  const second = Number(s.slice(12, 14))
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour < 24 && minute < 60 && second < 60
  )
}

/**
 * Versions must be positive integers, UNIQUE, and (for new ones) timestamps.
 *
 * Deliberately NOT "strictly increasing across the array". The registry is a
 * hand-maintained list that both branches append to, so the branch that merges
 * SECOND lands its entry last — even when its timestamp is older. Requiring the
 * array to be sorted would turn that ordinary merge into a failure the author has
 * to fix by hand-reordering, for no benefit: the runner sorts by version anyway,
 * and an older-timestamped migration simply back-fills (#472 already applies any
 * version absent from schema_version). Rails has no such constraint either — it
 * globs the migration files and sorts them.
 */
function validate(migrations: Migration[]): void {
  const seen = new Map<number, string>()
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new Error(`migration version must be a positive integer (got ${m.version})`)
    }
    const clash = seen.get(m.version)
    if (clash !== undefined) {
      throw new Error(
        `duplicate migration version ${m.version}: defined twice, as '${clash}' and '${m.name}'. ` +
          `Versions are unique — generate one with \`bun run migration:new <name>\`.`,
      )
    }
    seen.set(m.version, m.name)
    // Anything NEW must be a timestamp. Enforcing it here means a hand-typed MAX+1
    // fails on the author's very first test run — not at someone else's merge, and
    // never at a user's boot.
    if (m.version > LAST_SEQUENTIAL_VERSION && !isTimestampVersion(m.version)) {
      throw new Error(
        `migration ${m.version} ('${m.name}') uses a sequential version. New migrations must use a ` +
          `UTC timestamp (YYYYMMDDHHMMSS) so two branches can never claim the same number — run ` +
          `\`bun run migration:new ${m.name}\` and use the version it prints. ` +
          `(${LAST_SEQUENTIAL_VERSION} was the last hand-numbered migration.)`,
      )
    }
  }
}

/** How many pre-migration backups to retain per database file. */
export const MIGRATION_BACKUPS_TO_KEEP = 3

/** True when the backup file name (not a -wal/-shm sidecar) belongs to `dbFile`. */
function isBackupMain(name: string, dbFile: string): boolean {
  return name.startsWith(`${dbFile}.backup-v`) && !name.endsWith('-wal') && !name.endsWith('-shm')
}

/**
 * Copies the on-disk database (plus -wal/-shm sidecars when present) to a
 * timestamped sibling before a version-advancing run, then prunes to the last
 * MIGRATION_BACKUPS_TO_KEEP backups.
 *
 * Safety: called at startup while this process holds the ONLY connection
 * (Podium's server is the single writer), after `PRAGMA wal_checkpoint(TRUNCATE)`
 * folded the WAL into the main file — so a plain file copy is a consistent
 * snapshot. Returns the backup path, or undefined when nothing was copied.
 */
export function backupBeforeMigration(
  db: SqlDatabase,
  dbPath: string,
  fromVersion: number,
  toVersion: number,
): string | undefined {
  if (!existsSync(dbPath)) return undefined
  // Fold WAL content into the main DB file so the copy is self-consistent.
  // Harmless no-op under non-WAL journal modes. Must run outside a transaction.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${dbPath}.backup-v${fromVersion}-${toVersion}-${stamp}`
  copyFileSync(dbPath, backupPath)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`))
      copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`)
  }
  pruneBackups(dbPath)
  return backupPath
}

/** Keeps the newest MIGRATION_BACKUPS_TO_KEEP backup sets; deletes the rest. */
function pruneBackups(dbPath: string): void {
  const dir = dirname(dbPath)
  const dbFile = basename(dbPath)
  const mains = readdirSync(dir)
    .filter((name) => isBackupMain(name, dbFile))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  for (const stale of mains.slice(MIGRATION_BACKUPS_TO_KEEP)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(join(dir, `${stale.name}${suffix}`), { force: true })
    }
  }
}

/**
 * Applies all pending migrations. Returns the versions applied in this run.
 * Throws (without touching the schema) when the DB is newer than the code.
 */
export function runMigrations(
  db: SqlDatabase,
  migrations: Migration[] = MIGRATIONS,
  opts: { dbPath?: string } = {},
): number[] {
  validate(migrations)
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  )
  const current = dbSchemaVersion(db)
  const target = codeSchemaVersion(migrations)
  if (current > target) {
    throw new Error(
      `database schema version ${current} is newer than this build supports (${target}). ` +
        `Upgrade the Podium server (or restore the matching database) — downgrades are not supported.`,
    )
  }
  // What this DB has really applied — NOT "everything at or below MAX" (#472).
  const alreadyApplied = appliedMigrations(db)

  // A version already applied under a DIFFERENT name means two migrations were
  // authored with the same number on different branches (exactly what #216 did:
  // its `accounts` was numbered 016 while 016 `messages` was already applied).
  // Skipping it here would silently drop a migration; applying it would corrupt
  // the ledger. Refuse to boot, and say precisely what to do about it.
  for (const m of migrations) {
    const appliedName = alreadyApplied.get(m.version)
    if (appliedName !== undefined && appliedName !== m.name) {
      throw new Error(
        `duplicate migration version ${m.version}: this database already applied ` +
          `'${appliedName}', but this build defines '${m.name}' at the same version. ` +
          `Two branches claimed the same number — renumber '${m.name}' to ` +
          `${codeSchemaVersion(migrations) + 1} or higher and redeploy.`,
      )
    }
  }

  // Apply in VERSION order, not array order — the registry may be unsorted after two
  // branches each appended (#485). An older-timestamped migration that lands later
  // simply back-fills, which is exactly the case #472 made safe.
  const pending = inVersionOrder(migrations).filter((m) => !alreadyApplied.has(m.version))

  // #43: snapshot the database before applying anything — but only when it already
  // holds real tables (schema_version alone is a brand-new file).
  //
  // This predicate MUST use the same pending-set logic as the apply loop below.
  // It used to ask `m.version > current`, and leaving it that way while fixing only
  // the loop would let a back-filled (out-of-order) migration run with NO BACKUP —
  // trading a silent-skip bug for a silent-data-loss one.
  const hasPending = pending.length > 0
  if (hasPending && opts.dbPath !== undefined && opts.dbPath !== ':memory:') {
    const hasObjects = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'schema_version' LIMIT 1`,
      )
      .get()
    if (hasObjects !== undefined) backupBeforeMigration(db, opts.dbPath, current, target)
  }

  const applied: number[] = []
  const insert = db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (const m of pending) {
    // Deliberately hand-rolled, NOT @podium/runtime/sqlite `transaction()`
    // [spec:SP-3fe2]: each migration must be its own top-level BEGIN IMMEDIATE
    // with the version stamp committing atomically alongside the schema change.
    // The nesting-safe helper would degrade this to a SAVEPOINT if a caller ever
    // wrapped runMigrations in a transaction — then a later migration's failure
    // could roll back earlier already-stamped migrations, breaking the
    // one-transaction-per-migration ordering guarantee.
    db.exec('BEGIN IMMEDIATE')
    try {
      m.up(db)
      insert.run(m.version, m.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(
        `migration ${m.version} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    applied.push(m.version)
  }
  return applied
}
