/**
 * The cross-worker half of the harness's proof [POD-6980]: two test files, run by two
 * vitest workers of one run, each check that the other's database is a different one.
 *
 * `src/store/pg-test-isolation-1.test.ts` and `-2.test.ts` call
 * {@link provePgWorkerIsolation} with their labels swapped. Each writes a marker row
 * into its own worker database and tags that database with a comment (comments on
 * databases live in a shared catalog, so the admin connection sees every one). Each
 * then waits for the partner's tag, reads the partner's database, and checks that it
 * holds only the partner's marker, written by another process. A second tag,
 * `:done`, keeps each database alive until the partner has finished reading it.
 *
 * The two files must run at the same time, so the pair needs two workers; with one
 * worker (`PODIUM_TEST_WORKERS=1`) they skip.
 */

import { expect } from 'vitest'
import {
  connectPgTest,
  type PgTestClient,
  pgRunPrefix,
  pgTestEnvironment,
  pgUrlForDatabase,
  pgWorkerDatabase,
  quotePgIdentifier,
} from './pg-test-database'

const TAG = 'pg-isolation:'
/** How long a file waits for its partner. Both start together, so this is generous. */
export const PARTNER_TIMEOUT_MS = 40_000

/** False when this run cannot schedule the pair side by side. */
export function pairCanRun(env: Record<string, string | undefined> = process.env): boolean {
  return env.PODIUM_TEST_WORKERS?.trim() !== '1'
}

async function tag(admin: PgTestClient, database: string, note: string): Promise<void> {
  if (!/^[a-z0-9:_-]+$/.test(note)) throw new Error(`not a tag: ${note}`)
  await admin.unsafe(`COMMENT ON DATABASE ${quotePgIdentifier(database)} IS '${note}'`)
}

async function tags(admin: PgTestClient, run: string): Promise<Map<string, string | null>> {
  const rows = await admin.unsafe<{ datname: string; note: string | null }>(
    "SELECT datname, shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE starts_with(datname, $1)",
    [pgRunPrefix(run)],
  )
  return new Map(rows.map((row) => [row.datname, row.note]))
}

async function poll<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + PARTNER_TIMEOUT_MS
  for (;;) {
    const found = await check()
    if (found !== undefined) return found
    if (Date.now() > deadline) {
      throw new Error(
        `${what} within ${PARTNER_TIMEOUT_MS / 1000} s. The isolation pair must run in one ` +
          'run with two workers: name both files, or run the whole Postgres leg.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function provePgWorkerIsolation(self: string, partner: string): Promise<void> {
  const environment = pgTestEnvironment()
  const mine = await pgWorkerDatabase()
  const own = connectPgTest(mine.url)
  const admin = connectPgTest(environment.url)
  try {
    const [current] = await own.unsafe<{ name: string }>('SELECT current_database() AS name')
    expect(current?.name).toBe(mine.name)
    await own.unsafe('CREATE TABLE isolation_marker (label text NOT NULL, pid integer NOT NULL)')
    await own.unsafe('INSERT INTO isolation_marker (label, pid) VALUES ($1, $2)', [
      self,
      process.pid,
    ])
    await tag(admin, mine.name, `${TAG}${self}`)

    const theirs = await poll(`no database tagged by ${partner} appeared`, async () => {
      for (const [name, note] of await tags(admin, environment.run)) {
        if (note === `${TAG}${partner}` || note === `${TAG}${partner}:done`) return name
      }
      return undefined
    })
    expect(theirs).not.toBe(mine.name)

    const other = connectPgTest(pgUrlForDatabase(environment.url, theirs))
    try {
      const rows = await other.unsafe<{ label: string; pid: number }>(
        'SELECT label, pid FROM isolation_marker',
      )
      expect(rows.map((row) => row.label)).toEqual([partner])
      expect(rows[0]?.pid).not.toBe(process.pid)
    } finally {
      await other.close({ timeout: 5 })
    }
    const ownRows = await own.unsafe<{ label: string }>('SELECT label FROM isolation_marker')
    expect(ownRows.map((row) => row.label)).toEqual([self])

    // Keep this database until the partner has read it: it says `:done` when it
    // has, or its own database is gone because its file already ended.
    await tag(admin, mine.name, `${TAG}${self}:done`)
    await poll(`${partner} did not finish`, async () => {
      const now = await tags(admin, environment.run)
      if (!now.has(theirs) || now.get(theirs) === `${TAG}${partner}:done`) return true
      return undefined
    })
  } finally {
    await own.close({ timeout: 5 })
    await admin.close({ timeout: 5 })
  }
}
