/**
 * The Postgres test harness, inside one worker [POD-6980]. The cross-worker half is
 * `pg-test-isolation-1.test.ts` with its partner.
 */

import { describe, expect, it } from 'vitest'
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

describe.skipIf(testStoreEngine() !== 'pg')('postgres test databases', () => {
  it('gives the worker one database, cloned from the run template', async () => {
    const worker = await pgWorkerDatabase()
    expect(await pgWorkerDatabase()).toEqual(worker)
    const [row] = await query<{ name: string; templates: number }>(
      worker,
      'SELECT current_database() AS name, count(*)::int AS templates FROM podium_test_template',
    )
    expect(row).toEqual({ name: worker.name, templates: 1 })
  })

  it('clones a fresh database that shares no rows with the worker database', async () => {
    const worker = await pgWorkerDatabase()
    await query(worker, 'CREATE TABLE written_here (id integer)')
    const fresh = await clonePgTestDatabase()
    expect(fresh.name).not.toBe(worker.name)
    const tables = await query<{ name: string }>(
      fresh,
      "SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'written_here'",
    )
    expect(tables).toEqual([])
  })

  it('drops every database it made', async () => {
    const made = pgTestDatabasesCreated()
    expect(made.length).toBeGreaterThan(0)
    await dropPgTestDatabases()
    const admin = connectPgTest(pgTestEnvironment().url)
    try {
      const left = await admin.unsafe<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
        [made],
      )
      expect(left).toEqual([])
    } finally {
      await admin.close({ timeout: 5 })
    }
  })
})
