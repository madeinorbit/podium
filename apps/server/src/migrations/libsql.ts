/**
 * Libsql remote migrator [POD-3272].
 *
 * drizzle-orm/libsql's migrator reads a folder on disk and writes a ledger
 * with an extra `applied_at` column. The compiled binary carries no drizzle/
 * folder — migrations live in `drizzle-manifest.generated.ts` — and an imported
 * bun:sqlite database already has the bun ledger shape (`hash`, `created_at`,
 * `name`). So this path walks the same in-memory pending set the bun applier
 * does, through the remote client, and writes the SAME ledger.
 *
 * Backup is platform-managed: this path never copies a file.
 *
 * `PRAGMA foreign_keys=OFF` is issued as its own statement BEFORE the apply
 * batch. Inside a transaction that PRAGMA is a no-op, which is why the bun
 * path brackets drizzle's own transaction the same way.
 */

import { createLogger } from '@podium/logger'
import type { Client } from '@libsql/client/web'
import { MIGRATION_NAME_ALIASES as SHARED_MIGRATION_NAME_ALIASES } from '@podium/runtime/migration-ledger'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { type DrizzleMigration, outOfOrderPending } from './index'
import { applySchemaRepairsOnSession, repairReason } from './repair'

const log = createLogger('server:migrations')

const LEDGER = '__drizzle_migrations'
const MIGRATION_NAME_ALIASES = SHARED_MIGRATION_NAME_ALIASES

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

export interface LibsqlMigrationSession {
  execute(sql: string, args?: readonly (string | number | bigint | null)[]): Promise<{
    rows: readonly Record<string, unknown>[]
  }>
  batch(
    statements: readonly { sql: string; args?: readonly (string | number | bigint | null)[] }[],
  ): Promise<void>
}

function sessionFromClient(client: Client): LibsqlMigrationSession {
  return {
    async execute(sql, args) {
      const result = await client.execute(
        args === undefined ? sql : { sql, args: [...args] },
      )
      return { rows: result.rows as readonly Record<string, unknown>[] }
    },
    async batch(statements) {
      if (statements.length === 0) return
      await client.batch(
        statements.map((s) =>
          s.args === undefined ? s.sql : { sql: s.sql, args: [...s.args] },
        ),
        'write',
      )
    },
  }
}

async function appliedNames(session: LibsqlMigrationSession): Promise<Set<string>> {
  const present = await session.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [LEDGER],
  )
  if (present.rows[0] === undefined) return new Set()
  const rows = await session.execute(`SELECT name FROM ${LEDGER} WHERE name IS NOT NULL`)
  return new Set(
    rows.rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'),
  )
}

/**
 * Apply pending drizzle migrations over a libsql client.
 *
 * Same downgrade guard, out-of-order warning, alias handling and boot logging
 * as the bun applier. No backup. Returns the names applied in this run.
 */
export async function runLibsqlMigrations(
  client: Client,
  migrations: readonly DrizzleMigration[] = DRIZZLE_MIGRATIONS,
  opts: { skipSchemaRepair?: boolean } = {},
): Promise<string[]> {
  const session = sessionFromClient(client)
  return await runLibsqlMigrationsOn(session, migrations, opts)
}

export async function runLibsqlMigrationsOn(
  session: LibsqlMigrationSession,
  migrations: readonly DrizzleMigration[],
  opts: { skipSchemaRepair?: boolean } = {},
): Promise<string[]> {
  const applied = await appliedNames(session)

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

  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name))
  const semanticallyApplied = new Set(
    [...applied].map((name) => MIGRATION_NAME_ALIASES.get(name) ?? name),
  )
  const pending = ordered.filter((m) => !semanticallyApplied.has(m.name))

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

  if (pending.length === 0) {
    if (opts.skipSchemaRepair !== true) await reportRepairs(session)
    return []
  }

  await session.execute(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
    id INTEGER PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric,
    name text
  )`)
  // OFF is its own statement so it is not a no-op inside the apply batch.
  await session.execute('PRAGMA foreign_keys = OFF')
  try {
    const statements: { sql: string; args?: readonly (string | number | bigint | null)[] }[] = []
    for (const migration of pending) {
      for (const raw of migration.sql.split('--> statement-breakpoint')) {
        const sql = raw.trim()
        if (sql.length > 0) statements.push({ sql })
      }
      statements.push({
        sql: `INSERT INTO ${LEDGER} (hash, created_at, name) VALUES (?, ?, ?)`,
        args: ['', folderMillis(migration.name), migration.name],
      })
    }
    await session.batch(statements)
  } finally {
    await session.execute('PRAGMA foreign_keys = ON')
  }

  if (opts.skipSchemaRepair !== true) await reportRepairs(session)
  log.info('applied migrations', { applied: pending.map((m) => m.name) })
  return pending.map((m) => m.name)
}

async function reportRepairs(session: LibsqlMigrationSession): Promise<void> {
  for (const id of await applySchemaRepairsOnSession(session)) {
    log.warn('repaired a missing column', { column: id, reason: repairReason(id) })
  }
}

export async function configureLibsqlConnection(client: Client): Promise<void> {
  // WAL, busy_timeout and wal_checkpoint are hard SQL parse errors on Turso
  // (POD-3251). foreign_keys is honoured per connection.
  await client.execute('PRAGMA foreign_keys = ON')
}

export async function latestAppliedMigrationRemote(
  client: Client,
): Promise<string | undefined> {
  const session = sessionFromClient(client)
  const present = await session.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [LEDGER],
  )
  if (present.rows[0] === undefined) return undefined
  const row = await session.execute(
    `SELECT name FROM ${LEDGER} WHERE name IS NOT NULL ORDER BY name DESC LIMIT 1`,
  )
  const name = row.rows[0]?.name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}
