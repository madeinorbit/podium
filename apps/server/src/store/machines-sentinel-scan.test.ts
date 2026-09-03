/**
 * THE LIST THE SENTINEL SCAN WALKS IS THE SCHEMA'S, NOT SOMEBODY'S MEMORY.
 *
 * `MACHINE_ID_SITES` is written out in `machines.ts` because the boot check that
 * reads it replaced an upgrade that discovered the same set with `sqlite_master`
 * and `PRAGMA table_info` (POD-318, retired at POD-3246), and a store facade that
 * introspects its own database is exactly what this epic is removing.
 *
 * Writing a list down is safe only if something else keeps it honest. This test
 * DERIVES the set from `migrations/schema.ts` — the type source of truth, and the
 * thing a new table is actually added to — so a table that grows a machine column
 * without being listed fails here rather than being quietly unscanned.
 */

import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../migrations/schema'
import { MACHINE_ID_SITES } from './machines'

/** Every `table.column` in the schema that stores a machine id. */
function machineIdSitesInSchema(): string[] {
  const sites: string[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue
    const table = getTableName(value)
    for (const column of Object.values(getTableColumns(value))) {
      if (column.name === 'machine_id') sites.push(`${table}.machine_id`)
    }
    // `machines` stores the id as its own primary key, not as `machine_id`.
    if (table === 'machines') sites.push('machines.id')
  }
  return sites.sort()
}

describe('the machine-id site list', () => {
  it('names every machine column the schema declares, and nothing else', () => {
    expect([...MACHINE_ID_SITES].sort()).toEqual(machineIdSitesInSchema())
  })

  it('derives a non-empty set — a broken derivation would agree with anything', () => {
    expect(machineIdSitesInSchema().length).toBeGreaterThan(10)
    expect(machineIdSitesInSchema()).toContain('machines.id')
    expect(machineIdSitesInSchema()).toContain('sessions.machine_id')
  })
})
