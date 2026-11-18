/**
 * THE POSTGRES MIGRATION RUNNER [POD-6981, POD-6958 design 2.7].
 *
 * The Postgres chain (`./drizzle/`, bundled into `./manifest.generated.ts`) starts from
 * one baseline that already holds the whole schema, `workspace_id` included; the SQLite
 * chain's migrations are never replayed here. `./chain.ts` says how the baseline is
 * generated and when it freezes.
 *
 * DEPLOY STEP, NOT BOOT STEP. On hosted Postgres, migrating is a deploy step run before
 * new server processes start: `podium server migrate --database <url>`
 * ({@link pgMigrateCommand}), on the direct port with the migrator role. A server
 * booting on Postgres only reads the ledger ({@link checkPgLedger}) and refuses a
 * database that is behind its build or carries a migration it does not know. Tests and
 * local development may migrate at boot instead ({@link preparePgStoreSchema} with
 * `migrateAtBoot`). Self-hosted SQLite keeps migrating at boot, with its backup.
 *
 * THE LEDGER is drizzle's own Postgres ledger, `drizzle.__drizzle_migrations`, in the
 * shape drizzle-orm's migrator creates (so drizzle's tools can read it). Entries are
 * matched by NAME, as on SQLite.
 *
 * ONE TRANSACTION, ONE MIGRATOR. Every pending migration applies in one transaction,
 * which first runs `LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE`. A second
 * migrator waits on that lock, then reads the ledger the first one committed and finds
 * nothing to do. It is plain SQL: no advisory-lock function, and it holds through a
 * transaction pooler. EXCLUSIVE mode still admits plain reads, so a booting server's
 * ledger check never waits behind a migration; it sees the ledger as it was and, if a
 * migration is under way, refuses as behind.
 *
 * THE GUARDS are the SQLite runner's (`../ledger-guards.ts`): an applied name this build
 * does not define refuses (downgrade guard). An out-of-order pending migration (one that
 * sorts before the newest applied name) is the late-lineage signature of POD-1621. On
 * Postgres the hazard behind it is mostly absent, because `ALTER TABLE` does not rebuild
 * a table, so the runner warns and applies it, unless the migration is marked as a
 * rewrite (its SQL has a line `-- podium:rewrite`, for one that recreates a table or
 * copies its rows): then it refuses, because the rewrite was written without what the
 * other lineage added.
 */

import { createHash } from 'node:crypto'
import { createLogger } from '@podium/logger'
import postgres from 'postgres'
import type { DrizzleMigration } from '../index'
import {
  folderMillis,
  knownMigrationNames,
  newerDatabaseMessage,
  outOfOrderPending,
  unknownAppliedMigrations,
} from '../ledger-guards'
import { PG_MIGRATIONS } from './manifest.generated'

const log = createLogger('server:migrations:pg')

/** drizzle's Postgres ledger. */
export const PG_LEDGER_SCHEMA = 'drizzle'
export const PG_LEDGER_TABLE = '__drizzle_migrations'
const LEDGER = `"${PG_LEDGER_SCHEMA}"."${PG_LEDGER_TABLE}"`

/** drizzle-kit's separator between the statements of one migration. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

/** The line that marks a migration as a rewrite; see the header. */
export const REWRITE_MARK = '-- podium:rewrite'

/** The part of a postgres.js client the runner uses. */
type PgSql = postgres.Sql

export { PG_MIGRATIONS }

/** True when `migration` is marked as a rewrite. */
export function isRewrite(migration: DrizzleMigration): boolean {
  return migration.sql.split('\n').some((line) => line.trim() === REWRITE_MARK)
}

/** Why a runner refused a database. */
export type PgMigrationRefusalReason =
  /** The database has applied a migration this build does not define. */
  | 'newer-than-build'
  /** The database lacks migrations this build has (boot check only). */
  | 'behind-build'
  /** A pending migration marked as a rewrite sorts before an applied one. */
  | 'out-of-order-rewrite'

/** A refusal to migrate or to serve a database; nothing was changed. */
export class PgMigrationRefusal extends Error {
  constructor(
    readonly reason: PgMigrationRefusalReason,
    readonly migrations: readonly string[],
    message: string,
  ) {
    super(message)
    this.name = 'PgMigrationRefusal'
  }
}

/** What applying `migrations` to a database with `applied` in its ledger would do. */
export interface PgMigrationPlan {
  /** Applied names this build does not define (the downgrade guard's finding). */
  readonly unknown: readonly string[]
  /** Migrations to apply, in name order. */
  readonly pending: readonly DrizzleMigration[]
  /** Pending names that sort before the newest applied one. */
  readonly outOfOrder: readonly string[]
  /** The out-of-order ones marked as rewrites, which refuse. */
  readonly outOfOrderRewrites: readonly string[]
}

/** The plan, from ledger names alone: the guards' pure half. */
export function planPgMigrations(
  applied: readonly string[],
  migrations: readonly DrizzleMigration[],
): PgMigrationPlan {
  const known = knownMigrationNames(migrations.map((m) => m.name))
  const done = new Set(applied)
  const pending = [...migrations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((m) => !done.has(m.name))
  const outOfOrder = outOfOrderPending(
    applied,
    pending.map((m) => m.name),
  )
  const late = new Set(outOfOrder)
  return {
    unknown: unknownAppliedMigrations(applied, known),
    pending,
    outOfOrder,
    outOfOrderRewrites: pending.filter((m) => late.has(m.name) && isRewrite(m)).map((m) => m.name),
  }
}

/** Refuse what the plan forbids: an unknown applied migration, a late rewrite. */
function enforce(plan: PgMigrationPlan): void {
  const [unknown] = plan.unknown
  if (unknown !== undefined) {
    throw new PgMigrationRefusal('newer-than-build', plan.unknown, newerDatabaseMessage(unknown))
  }
  if (plan.outOfOrderRewrites.length > 0) {
    throw new PgMigrationRefusal(
      'out-of-order-rewrite',
      plan.outOfOrderRewrites,
      `pending migration(s) ${plan.outOfOrderRewrites.join(', ')} are marked as rewrites and ` +
        'sort before migrations this database has already applied. A rewrite written without ' +
        'the other lineage can drop what it added [POD-1621]; regenerate it on top of the ' +
        'newer migrations under a later name.',
    )
  }
  if (plan.outOfOrder.length > 0) {
    log.warn(
      'out-of-order migrations sort BEFORE migrations this database has already applied and will be applied now. On Postgres ALTER TABLE does not rebuild, so this is usually harmless; a migration that recreates a table must carry the rewrite mark [POD-1621]',
      { migrations: plan.outOfOrder },
    )
  }
}

/** The ledger's names in apply order, or `undefined` when the database has no ledger. */
async function readLedger(sql: PgSql | postgres.TransactionSql): Promise<string[] | undefined> {
  const [exists] = await sql.unsafe<{ ledger: string | null }[]>(
    `SELECT to_regclass('${LEDGER}')::text AS ledger`,
  )
  if (exists?.ledger === null || exists?.ledger === undefined) return undefined
  const rows = await sql.unsafe<{ name: string }[]>(
    `SELECT name FROM ${LEDGER} WHERE name IS NOT NULL ORDER BY id`,
  )
  return rows.map((row) => row.name)
}

/** Postgres's answers to a CREATE … IF NOT EXISTS that raced another one. */
const CREATE_RACE_CODES = new Set(['23505', '42P06', '42P07'])

/**
 * Create the ledger if it is missing. Two migrators on a fresh database can both pass
 * `IF NOT EXISTS` and collide in the catalog; the loser retries and finds it there.
 */
async function ensureLedger(sql: PgSql): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${PG_LEDGER_SCHEMA}"`)
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS ${LEDGER} (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint,
          name text,
          applied_at timestamp with time zone DEFAULT now()
        )`,
      )
      return
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (attempt >= 3 || typeof code !== 'string' || !CREATE_RACE_CODES.has(code)) throw error
    }
  }
}

/** One migration's statements; chunks that hold only comments are skipped. */
export function migrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) =>
      chunk.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')),
    )
}

/**
 * Apply every pending migration in one transaction under the ledger lock. Returns the
 * names applied in this run (empty when the database was current). Throws a
 * {@link PgMigrationRefusal}, without changing anything, when a guard refuses.
 */
export async function migratePg(
  sql: PgSql,
  migrations: readonly DrizzleMigration[] = PG_MIGRATIONS,
): Promise<string[]> {
  await ensureLedger(sql)
  const applied = await sql.begin(async (tx) => {
    // First, before reading the ledger: a second migrator waits here, and its read
    // below then sees what the first one committed.
    await tx.unsafe(`LOCK TABLE ${LEDGER} IN EXCLUSIVE MODE`)
    const plan = planPgMigrations((await readLedger(tx)) ?? [], migrations)
    enforce(plan)
    for (const migration of plan.pending) {
      for (const statement of migrationStatements(migration.sql)) await tx.unsafe(statement)
      await tx.unsafe(`INSERT INTO ${LEDGER} (hash, created_at, name) VALUES ($1, $2, $3)`, [
        createHash('sha256').update(migration.sql).digest('hex'),
        folderMillis(migration.name),
        migration.name,
      ])
    }
    return plan.pending.map((m) => m.name)
  })
  // The planner's statistics after a schema change (POD-6958 design 2.8): autoanalyze
  // reaches a table only once enough of it has changed, and a migration that builds an
  // index or rewrites rows changes the plans at once. Outside the migration's
  // transaction, as ANALYZE must be for its statistics to outlive a rollback.
  if (applied.length > 0) await sql.unsafe('ANALYZE')
  return applied
}

/**
 * THE BOOT CHECK: read the ledger and refuse a database this build cannot serve, one
 * that carries a migration the build does not define or lacks one it has. Changes
 * nothing. Returns the number of applied migrations.
 */
export async function checkPgLedger(
  sql: PgSql,
  migrations: readonly DrizzleMigration[] = PG_MIGRATIONS,
): Promise<number> {
  const applied = (await readLedger(sql)) ?? []
  const plan = planPgMigrations(applied, migrations)
  const [unknown] = plan.unknown
  if (unknown !== undefined) {
    throw new PgMigrationRefusal('newer-than-build', plan.unknown, newerDatabaseMessage(unknown))
  }
  if (plan.pending.length > 0) {
    const names = plan.pending.map((m) => m.name)
    throw new PgMigrationRefusal(
      'behind-build',
      names,
      `the database is behind this build: ${names.length} migration(s) not applied ` +
        `(${names.join(', ')}). Run \`podium server migrate --database <url>\` before starting ` +
        'the server (a deploy step on hosted Postgres).',
    )
  }
  return applied.length
}

/** A connection for one migration or check, quiet about IF NOT EXISTS notices. */
function connect(url: string): PgSql {
  return postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'podium-migrate' },
  })
}

/**
 * What a Postgres store runs at boot: the ledger check, or with `migrateAtBoot` (tests
 * and local development only) the migration itself. Returns the names applied, empty
 * for a check.
 */
export async function preparePgStoreSchema(
  url: string,
  options: {
    readonly migrateAtBoot?: boolean
    readonly migrations?: readonly DrizzleMigration[]
  } = {},
): Promise<string[]> {
  const sql = connect(url)
  try {
    if (options.migrateAtBoot === true) return await migratePg(sql, options.migrations)
    await checkPgLedger(sql, options.migrations)
    return []
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const USAGE =
  'usage: podium server migrate --database <postgres-url> [--check]\n' +
  '  Applies the pending Postgres migrations in one transaction (a deploy step on hosted).\n' +
  '  --check  apply nothing; exit 1 when the database is behind this build or newer.'

/** Output sinks of {@link pgMigrateCommand}. */
export interface PgMigrateIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

/**
 * `podium server migrate --database <url> [--check]`. Returns the exit code: 0 done,
 * 1 refused or failed, 2 usage. Never prints the URL, which carries the password.
 */
export async function pgMigrateCommand(
  argv: readonly string[],
  io: PgMigrateIo = { out: console.log, err: console.error },
  migrations: readonly DrizzleMigration[] = PG_MIGRATIONS,
): Promise<number> {
  let url: string | undefined
  let check = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--check') check = true
    else if (arg === '--database') url = argv[++i]
    else if (arg.startsWith('--database=')) url = arg.slice('--database='.length)
    else if (arg === '--help' || arg === '-h') {
      io.out(USAGE)
      return 0
    } else {
      io.err(`podium server migrate: unknown argument '${arg}'\n${USAGE}`)
      return 2
    }
  }
  if (url === undefined || !/^postgres(?:ql)?:\/\//i.test(url)) {
    io.err(`podium server migrate: --database needs a postgres:// URL\n${USAGE}`)
    return 2
  }
  const sql = connect(url)
  try {
    if (check) {
      const count = await checkPgLedger(sql, migrations)
      io.out(`the database is current: ${count} migration(s) applied.`)
      return 0
    }
    const applied = await migratePg(sql, migrations)
    io.out(
      applied.length === 0
        ? 'the database is current: nothing to apply.'
        : `applied ${applied.length} migration(s): ${applied.join(', ')}`,
    )
    return 0
  } catch (error) {
    io.err(`podium server migrate: ${(error as Error).message}`)
    return 1
  } finally {
    await sql.end({ timeout: 5 })
  }
}
