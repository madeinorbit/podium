/**
 * WHAT THIS MACHINE'S DATABASE HAS ALREADY BEEN MIGRATED TO — readable by a
 * process that is not the server.
 *
 * The server's migrator (`apps/server/src/migrations`) owns the ledger and the
 * decision to apply; this module owns only the two facts everyone else needs to
 * ask about it, and it lives here rather than there because its other reader is
 * the DAEMON. Before a daemon converges the install its co-located server runs
 * from, it has to know whether the build it is about to swap in could open this
 * database at all (POD-2213): a build that cannot refuses to start, and the
 * thing that would put the newer build back is the server that will not start.
 *
 * Read-only and creating nothing: a machine with no database must come back as
 * "no database", never as "a fresh empty one I just made".
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type DatabaseBackend, resolveDatabaseBackend, stateDir } from './config'
import { createLibsqlClient } from './libsql'
import { openDatabase } from './sqlite'

/** drizzle's own migrations ledger, the table the server's migrator writes. */
const LEDGER = '__drizzle_migrations'

/**
 * Migration identities deployed locally before the same change was rebased
 * upstream under a different generated timestamp. THE ONE HOME for that map:
 * the server's downgrade guard and the daemon's convergence gate have to agree
 * about which ledger entries are the same migration, and two copies of this is
 * how they stop agreeing.
 */
export const MIGRATION_NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ['20260722210552_session-spawn-failure', '20260724134702_session-spawn-failure'],
])

/** The name a build would define for this ledger entry. */
export function canonicalMigrationName(name: string): string {
  return MIGRATION_NAME_ALIASES.get(name) ?? name
}

/** `podium.db` below an instance state root — the file the server's store opens. */
export function instanceDatabasePath(dir: string = stateDir()): string {
  return join(dir, 'podium.db')
}

/**
 * The migration names this database has applied.
 *
 * `undefined` means THERE IS NO DATABASE HERE, which is a different answer from
 * "none applied" and callers act on the difference: a daemon on a machine that
 * owns no database has nothing a downgrade could strand (§13.3 of the update
 * design — "a daemon owns no database", so its rollback is always safe).
 *
 * A database with no ledger answers `[]`: nothing has been applied, so there is
 * nothing an older build could fail to understand.
 */
export function readAppliedMigrations(path: string = instanceDatabasePath()): string[] | undefined {
  if (!existsSync(path)) return undefined
  const db = openDatabase(path, { readOnly: true })
  try {
    const present = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(LEDGER)
    if (present === undefined) return []
    const rows = db.prepare(`SELECT name FROM ${LEDGER} WHERE name IS NOT NULL`).all() as {
      name: string
    }[]
    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

/**
 * Whether a remote error means THERE IS NO DATABASE, vs a failure to ask.
 *
 * The daemon's downgrade guard treats `undefined` as "this machine owns no
 * database, rollback is always safe". A network blip or an auth failure must
 * NOT look like that — it would silently disarm the guard. Only an error that
 * says the database itself is not provisioned is absence.
 */
export function isAbsentTursoDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not found|does not exist|404|no such database|could not find database/i.test(message)
}

/**
 * The migration names a REMOTE database has applied.
 *
 * `undefined` means the database is not provisioned. An empty list means it
 * exists and has applied nothing. A throw means we could not tell — the
 * caller must not treat that as absence.
 */
export async function readAppliedMigrationsRemote(options: {
  url: string
  authToken: string
}): Promise<string[] | undefined> {
  const client = createLibsqlClient(options)
  try {
    const present = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      args: [LEDGER],
    })
    if (present.rows[0] === undefined) return []
    const rows = await client.execute(`SELECT name FROM ${LEDGER} WHERE name IS NOT NULL`)
    return rows.rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string')
  } catch (error) {
    if (isAbsentTursoDatabaseError(error)) return undefined
    throw error
  } finally {
    client.close()
  }
}

/**
 * What THIS INSTANCE's database has applied, answering through the backend
 * the instance is configured for.
 *
 * On sqlite this is the file-stat distinction (`undefined` = no podium.db).
 * On Turso there is no path to stat: no URL is absence, a connected empty
 * database is `[]`, and a transport/auth failure throws so the downgrade
 * guard cannot mistake an outage for "no database here".
 */
export async function readInstanceAppliedMigrations(
  backend: DatabaseBackend = resolveDatabaseBackend(),
  sqlitePath: string = instanceDatabasePath(),
): Promise<string[] | undefined> {
  if (backend.kind === 'sqlite') return readAppliedMigrations(sqlitePath)
  return await readAppliedMigrationsRemote({
    url: backend.url,
    authToken: backend.authToken,
  })
}
