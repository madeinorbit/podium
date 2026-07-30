/**
 * THE ADAPTER'S SCHEMA, AND THE FIXTURE THAT MIRRORS IT.
 *
 * `test-support.ts` hand-writes the DDL for the tables this adapter's repository
 * reads, so that the package's own unit tests can exercise real SQL without
 * depending on `apps/server`'s migrator. Its comment has said "keep in sync with
 * that schema" since it was written, which is a convention, and a convention
 * between two files in different packages is a drift waiting to happen: the
 * fixture would keep passing against a column the product no longer has, and the
 * suite would go green on a shape nothing deployed.
 *
 * POD-305 gave this adapter the schema-as-code, so the mirroring is now
 * CHECKABLE. These tests compare the fixture's actual columns against the drizzle
 * schema's declared ones.
 *
 * The drizzle-orm import is an AUTHORING import — a devDependency, exactly as in
 * `apps/server/src/migrations/schema.ts`. Runtime code never imports drizzle-orm,
 * and this is a test.
 */

import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { appliedMutations, changes } from './schema'
import { createTestSyncDatabase } from './test-support'

/** The column names the drizzle schema declares for a table. */
const declaredColumns = (table: Parameters<typeof getTableConfig>[0]): string[] =>
  getTableConfig(table)
    .columns.map((c) => c.name)
    .sort()

/** The column names the in-memory fixture actually creates. */
function fixtureColumns(table: string): string[] {
  const db = createTestSyncDatabase()
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  db.close()
  return rows.map((r) => r.name).sort()
}

describe('the test fixture mirrors the adapter-owned schema', () => {
  it('agrees on the change log’s columns, including the provenance triple', () => {
    // The one that would have drifted: POD-305 added three columns to the real
    // table, and without this the fixture would have kept creating the old shape
    // while every test using it passed.
    expect(fixtureColumns('changes')).toEqual(declaredColumns(changes))
  })

  it('agrees on the receipt table’s columns', () => {
    expect(fixtureColumns('applied_mutations')).toEqual(declaredColumns(appliedMutations))
  })

  it('the comparison is not vacuous — both sides are non-empty and specific', () => {
    // Guard against the shape where `getTableConfig` returns nothing and the
    // fixture's PRAGMA also returns nothing, making every assertion above
    // `[] === []`.
    expect(declaredColumns(changes)).toContain('causation_id')
    expect(fixtureColumns('changes')).toContain('seq')
    expect(declaredColumns(changes).length).toBeGreaterThan(6)
  })
})

describe('the change log keeps AUTOINCREMENT', () => {
  it('declares seq as an autoincrementing primary key', () => {
    // Not stylistic. Without AUTOINCREMENT, SQLite reuses the rowids of deleted
    // rows — and head-pruning (ADR 2 D5) deletes from the TAIL of the log, so a
    // reused seq would hand two different changes the same position in the ONE
    // global sequence and every replica that saw the first would skip the second.
    const seq = getTableConfig(changes).columns.find((c) => c.name === 'seq')
    expect(seq?.primary).toBe(true)
    expect((seq as { autoIncrement?: boolean } | undefined)?.autoIncrement).toBe(true)
  })

  it('and the fixture creates it that way too', () => {
    // sqlite_master is the only place the keyword survives — PRAGMA table_info
    // reports the column as an ordinary INTEGER primary key either way, so a
    // fixture that lost AUTOINCREMENT would pass the column comparison above.
    const db = createTestSyncDatabase()
    const ddl = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'changes'").get() as { sql: string }
    ).sql
    db.close()
    expect(ddl.toUpperCase()).toContain('AUTOINCREMENT')
  })
})
