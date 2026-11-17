/**
 * The Postgres test harness, inside one worker [POD-6980]. The cross-worker half is
 * `pg-test-isolation-1.test.ts` with its partner.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PG_MIGRATIONS } from '../migrations/pg/index'
import { openStoreDatabase } from '../store-database'
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
    for (const location of [':memory:', (await pgWorkerDatabase()).url]) {
      await expect(openStoreDatabase(location)).rejects.toThrow(
        /^apps\/server\/src\/store\/pg-test-database\.test\.ts opened a store .*Add the file to "pending" in apps\/server\/test-store-engines\.json/,
      )
    }
  })

  it('drops every database it made', async () => {
    madeInBeforeEach = []
    const made = pgTestDatabasesCreated()
    expect(made).toContain(fileScoped.name)
    await dropPgTestDatabases()
    expect(await existing(made)).toEqual([])
  })
})
