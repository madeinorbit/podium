/**
 * The Postgres leg's template starts from the rows a fresh SQLite store holds [POD-6994].
 *
 * Two checks on the `server-store-pg` lane. The copy itself: a fresh SQLite chain-head
 * image's rows, copied into a migrated Postgres database by the generic step, read back
 * through the store's Postgres driver equal the SQLite rows, table by table. And the run's
 * template: every table the SQLite image seeds holds the same number of rows in a clone.
 */

import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { migratePg } from '../migrations/pg/index'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import {
  copySeedTables,
  type SeedTable,
  sqliteImageSeedTables,
} from '../test-support/pg-template-seed'
import {
  clonePgTestDatabase,
  emptyPgTestDatabase,
  testStoreEngine,
} from '../test-support/pg-test-database'
import { buildSchemaImage } from '../test-support/pre-migrated-store.image'

/** A row as a comparable line: SQLite's 0/1 for a boolean, keys sorted. */
function line(row: Record<string, unknown>): string {
  const entries = Object.entries(row)
    .map(([key, value]): [string, unknown] => [
      key,
      value === true ? 1 : value === false ? 0 : typeof value === 'bigint' ? Number(value) : value,
    ])
    .sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries)
}

async function readTables(
  url: string,
  tables: readonly SeedTable[],
): Promise<Map<string, string[]>> {
  const driver = createPgStoreDriver({ url, poolSize: 1, strictTimestamps: true })
  try {
    const session = await driver.openReader()
    try {
      const out = new Map<string, string[]>()
      for (const { name } of tables) {
        const result = await session.execute({
          sql: `SELECT * FROM "${name}"`,
          params: [],
          method: 'all',
          intent: 'read',
        })
        out.set(name, (result.rows as Record<string, unknown>[]).map(line).sort())
      }
      return out
    } finally {
      await session.close()
    }
  } finally {
    await driver.close()
  }
}

describe.runIf(testStoreEngine() === 'pg')('the Postgres template seed', () => {
  const sqlite = sqliteImageSeedTables(buildSchemaImage())

  it('seeds something: a fresh SQLite store holds rows, its first admin among them', () => {
    expect(sqlite.map((table) => table.name)).toContain('users')
  })

  it('copies every seeded SQLite row into Postgres, value for value', async () => {
    const { url } = await emptyPgTestDatabase()
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await migratePg(sql)
      await copySeedTables(sql, sqlite)
    } finally {
      await sql.end({ timeout: 5 })
    }
    const copied = await readTables(url, sqlite)
    for (const table of sqlite) {
      expect({ table: table.name, rows: copied.get(table.name) }).toEqual({
        table: table.name,
        rows: table.rows.map(line).sort(),
      })
    }
  })

  it('gives the run’s template the same seeded tables and row counts', async () => {
    const { url } = await clonePgTestDatabase()
    const cloned = await readTables(url, sqlite)
    expect(
      Object.fromEntries(sqlite.map((table) => [table.name, cloned.get(table.name)?.length])),
    ).toEqual(Object.fromEntries(sqlite.map((table) => [table.name, table.rows.length])))
  })
})
