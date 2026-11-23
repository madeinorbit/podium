/**
 * EVERY TABLE DECLARES ITS RETENTION (POD-7035, audit guard 3).
 *
 * The tables are read from a store the migrations built, not from a list: a new
 * table fails here the day it is added, until `retention.ts` says what removes
 * its rows or what bounds them, or why it is kept.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import {
  CREATED_OUTSIDE_MIGRATIONS,
  FTS_SHADOW_SUFFIXES,
  RETENTION_EXEMPT,
  TABLE_RETENTION,
  type TableRetention,
} from './retention'

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function migratedTables(): Promise<string[]> {
  store = await openTestStore(':memory:')
  const db = (store as unknown as { db: SqlDatabase }).db
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string; sql: string | null }[]
  const virtual = rows
    .filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? ''))
    .map((row) => row.name)
  const shadows = new Set(
    virtual.flatMap((name) => FTS_SHADOW_SUFFIXES.map((suffix) => `${name}${suffix}`)),
  )
  return rows
    .map((row) => row.name)
    .filter((name) => !RETENTION_EXEMPT.has(name) && !shadows.has(name))
}

/** A declaration that says something: a job, a bound or a reason, in a sentence. */
function explained(retention: TableRetention): boolean {
  const text = retention.kind === 'unbounded' ? retention.reason : retention.by
  return text.trim().length >= 10
}

describe('table retention (POD-7035)', () => {
  it('declares a retention for every table the migrations create', async () => {
    const undeclared = (await migratedTables()).filter((name) => !(name in TABLE_RETENTION))
    expect(undeclared, 'declare these in apps/server/src/store/retention.ts').toEqual([])
  })

  it('declares no table the migrations do not create', async () => {
    const tables = new Set(await migratedTables())
    const stale = Object.keys(TABLE_RETENTION).filter(
      (name) => !tables.has(name) && !CREATED_OUTSIDE_MIGRATIONS.has(name),
    )
    expect(stale, 'remove these from apps/server/src/store/retention.ts').toEqual([])
  })

  it('explains every declaration', () => {
    const bare = Object.entries(TABLE_RETENTION)
      .filter(([, retention]) => !explained(retention))
      .map(([name]) => name)
    expect(bare).toEqual([])
  })

  it('names the janitor job that bounds each table the audit found growing', () => {
    // The two tables the audit found growing with no job behind them: a
    // regression to `unbounded` or a bare bound would hide the next one.
    expect(TABLE_RETENTION.applied_mutations).toMatchObject({
      kind: 'pruned',
      by: expect.stringContaining('applied-mutations-prune'),
    })
    expect(TABLE_RETENTION.queued_messages).toMatchObject({
      kind: 'pruned',
      by: expect.stringContaining('queued-messages-expiry'),
    })
  })
})
