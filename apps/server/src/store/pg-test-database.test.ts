/**
 * The Postgres test harness, inside one worker [POD-6980]. The cross-worker half is
 * `pg-test-isolation-1.test.ts` with its partner.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PG_MIGRATIONS } from '../migrations/pg/index'
import { openStoreDatabase, PostgresLocationError } from '../store-database'
import {
  clonePgTestDatabase,
  connectPgTest,
  dropPgTestDatabases,
  type PgTestDatabase,
  pgTestDatabasesCreated,
  pgTestEnvironment,
  pgWorkerDatabase,
  testStoreEngine,
} from '../test-support/pg-test-database'
import {
  containerRunArgs,
  PG_TEST_TMPFS_MIB,
  tmpfsWorkerProblem,
} from '../test-support/pg-test-host'

async function query<Row>(database: PgTestDatabase, sql: string): Promise<Row[]> {
  const client = connectPgTest(database.url)
  try {
    return await client.unsafe<Row>(sql)
  } finally {
    await client.close({ timeout: 5 })
  }
}

async function existing(names: readonly string[]): Promise<string[]> {
  const admin = connectPgTest(pgTestEnvironment().url)
  try {
    const rows = await admin.unsafe<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
      [names],
    )
    return rows.map((row) => row.datname)
  } finally {
    await admin.close({ timeout: 5 })
  }
}

describe.skipIf(testStoreEngine() !== 'pg')('postgres test databases', () => {
  let fileScoped: PgTestDatabase
  let testScoped: PgTestDatabase | undefined
  let madeInBeforeEach: PgTestDatabase[] = []

  beforeAll(async () => {
    fileScoped = await clonePgTestDatabase()
  })

  beforeEach(async () => {
    madeInBeforeEach.push(await clonePgTestDatabase())
  })

  it('gives the worker one database, cloned from the run template', async () => {
    const worker = await pgWorkerDatabase()
    expect(await pgWorkerDatabase()).toEqual(worker)
    // The template is the migrated Postgres chain (POD-6981): its ledger comes along.
    const [row] = await query<{ name: string; migrations: number }>(
      worker,
      'SELECT current_database() AS name, count(*)::int AS migrations FROM drizzle.__drizzle_migrations',
    )
    expect(row).toEqual({ name: worker.name, migrations: PG_MIGRATIONS.length })
  })

  it('clones a fresh database that shares no rows with the worker database', async () => {
    const worker = await pgWorkerDatabase()
    await query(worker, 'CREATE TABLE written_here (id integer)')
    testScoped = await clonePgTestDatabase()
    expect(testScoped.name).not.toBe(worker.name)
    const tables = await query<{ name: string }>(
      testScoped,
      "SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'written_here'",
    )
    expect(tables).toEqual([])
  })

  it('drops a clone when the test that made it ends, and keeps file-scoped ones', async () => {
    const earlier = madeInBeforeEach.slice(0, -1).map((database) => database.name)
    const current = madeInBeforeEach.at(-1)?.name as string
    expect(earlier).toHaveLength(2)
    expect(await existing([...earlier, testScoped?.name as string])).toEqual([])
    const kept = [fileScoped.name, (await pgWorkerDatabase()).name, current]
    expect((await existing(kept)).sort()).toEqual([...kept].sort())
  })

  it('refuses a SQLite store open and names the list this file belongs on', async () => {
    await expect(openStoreDatabase(':memory:')).rejects.toThrow(
      /^apps\/server\/src\/store\/pg-test-database\.test\.ts opened a SQLite store \(:memory:\) .*Add the file to "pending" in apps\/server\/test-store-engines\.json/,
    )
  })

  it('refuses a Postgres URL at the SQLite opener before any test opener runs', async () => {
    // A URL is refused as a URL on every leg; a store on one opens through
    // StoreDatabase.open, which chooses the engine from the location.
    await expect(openStoreDatabase((await pgWorkerDatabase()).url)).rejects.toBeInstanceOf(
      PostgresLocationError,
    )
  })

  it('drops every database it made', async () => {
    madeInBeforeEach = []
    const made = pgTestDatabasesCreated()
    expect(made).toContain(fileScoped.name)
    await dropPgTestDatabases()
    expect(await existing(made)).toEqual([])
  })
})

describe('the test server tmpfs and the lane workers (POD-6994)', () => {
  it('admits the workers that fit and names the count that does when they do not', () => {
    const fresh = PG_TEST_TMPFS_MIB - 60
    expect(tmpfsWorkerProblem(6, fresh)).toBeUndefined()
    expect(tmpfsWorkerProblem(10, fresh)).toMatch(
      /10 worker\(s\) need about 3200 MiB .*run with PODIUM_TEST_WORKERS=6 or fewer/,
    )
    expect(tmpfsWorkerProblem(1, 100)).not.toMatch(/PODIUM_TEST_WORKERS=/)
  })

  it('sizes the container tmpfs from the stated size', () => {
    expect(containerRunArgs(5432)).toContain(
      `/var/lib/postgresql/data:rw,size=${PG_TEST_TMPFS_MIB}m`,
    )
  })
})
