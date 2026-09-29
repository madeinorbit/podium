/**
 * THE `accepted` DELIVERY STATUS AND THE `delivery_held` DETAIL (POD-4885).
 *
 * SQLite cannot widen a CHECK in place, so the migration rebuilds `messages`.
 * These tests run it on a database created at the previous schema, holding a
 * row in every status that schema knew:
 *
 *  - every row survives exactly as it was, with the new column null;
 *  - the rebuilt table is the old one plus the one column and its CHECK, with
 *    the delivery-status CHECK admitting `accepted` and nothing else changed;
 *  - `accepted` and a `held` kind can be written, and the CHECKs still refuse a
 *    status or a kind nobody declared;
 *  - a second boot applies nothing and changes nothing.
 */

import { MESSAGE_DELIVERY_STATUSES, MESSAGE_HELD } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

const ACCEPTED = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_accepted-delivery-status'))
const DROP = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_drop-legacy-message-status'))
/** Up to and including this migration: what it leaves, before any later one. */
const THROUGH = DRIZZLE_MIGRATIONS.slice(0, ACCEPTED + 1)

/** Every status the previous schema's CHECK admitted, written out: a test that
 *  asked the model for this list would already include `accepted`. */
const PREVIOUS_STATUSES = [
  'stored',
  'dispatched',
  'reached-machine',
  'typing',
  'typed',
  'confirmed',
  'cancelled',
  'failed',
  'expired',
  'unknown',
] as const

interface TableShape {
  columns: Record<string, { type: string; notnull: number; dflt: string | null; pk: number }>
  checks: Record<string, string>
  indexes: Record<string, string>
}

function shape(db: SqlDatabase): TableShape {
  const columns: TableShape['columns'] = {}
  for (const c of db.prepare('PRAGMA table_xinfo(messages)').all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>) {
    columns[c.name] = { type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }
  }
  const table = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql: string }
  ).sql
  const checks: TableShape['checks'] = {}
  for (const m of table.matchAll(/CONSTRAINT\s+[`"]?(\w+)[`"]?\s+CHECK\s*\(/g)) {
    let depth = 1
    let end = m.index + m[0].length
    for (; depth > 0; end++) depth += table[end] === '(' ? 1 : table[end] === ')' ? -1 : 0
    checks[m[1] ?? ''] = table.slice(m.index + m[0].length, end - 1).trim()
  }
  const indexes: TableShape['indexes'] = {}
  for (const i of db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL",
    )
    .all() as Array<{ name: string; sql: string }>) {
    indexes[i.name] = i.sql
  }
  return { columns, checks, indexes }
}

const allRows = (db: SqlDatabase) =>
  db.prepare('SELECT * FROM messages ORDER BY id').all() as Array<Record<string, unknown>>

/** A database one migration short of `accepted`, with a row in every status it knew. */
function previousDatabase(): SqlDatabase {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, ACCEPTED))
  const insert = db.prepare(
    `INSERT INTO messages (id, thread_id, from_kind, to_kind, to_id, body, created_at,
       delivery_status, delivered_to, injected_at, transcript_item_id, harness_ref_json,
       notice_dismissed_at, retract_requested_at, attachments_json, expects_response)
     VALUES (?, ?, 'operator', 'session', 'sess_to', ?, ?, ?, 'sess_to', 't1', 'item-1',
       '[{"kind":"turn","id":"t-1"}]', 't4', 't5', '[]', 1)`,
  )
  PREVIOUS_STATUSES.forEach((status, i) => {
    insert.run(
      `m-${status}`,
      `thread-${status}`,
      `body of ${status}`,
      `2026-09-0${1 + (i % 9)}T00:00:00.000Z`,
      status,
    )
  })
  return db
}

describe('the accepted-delivery-status migration', () => {
  it('comes after the legacy drop, and the fixture is really at the previous schema', () => {
    expect(DROP).toBeGreaterThan(0)
    expect(ACCEPTED).toBeGreaterThan(DROP)
    const db = previousDatabase()
    expect(shape(db).columns).not.toHaveProperty('delivery_held')
    expect(() =>
      db.prepare("UPDATE messages SET delivery_status = 'accepted' WHERE id = 'm-typed'").run(),
    ).toThrow(/CHECK/)
  })

  it('carries every row across exactly as it was, the new column null', () => {
    const db = previousDatabase()
    const before = allRows(db)
    expect(before).toHaveLength(PREVIOUS_STATUSES.length)

    expect(runDrizzleMigrations(db, THROUGH)).toEqual([DRIZZLE_MIGRATIONS[ACCEPTED]?.name])

    const after = allRows(db)
    expect(after).toEqual(before.map((row) => ({ ...row, delivery_held: null })))
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    expect(db.prepare('PRAGMA foreign_key_check(messages)').all()).toEqual([])
  })

  it('rebuilds the table as the old one plus one column and its CHECK, admitting accepted', () => {
    const db = previousDatabase()
    const before = shape(db)
    runDrizzleMigrations(db, THROUGH)
    const after = shape(db)

    expect(after.columns).toEqual({
      ...before.columns,
      delivery_held: { type: 'TEXT', notnull: 0, dflt: null, pk: 0 },
    })
    expect(after.checks).toEqual({
      ...before.checks,
      messages_delivery_status: `delivery_status IN (${MESSAGE_DELIVERY_STATUSES.map((s) => `'${s}'`).join(',')})`,
      messages_delivery_held: `delivery_held IN (${MESSAGE_HELD.map((s) => `'${s}'`).join(',')})`,
    })
    // The old CHECK was the same list without `accepted`: only widened.
    expect(before.checks.messages_delivery_status).toBe(
      `delivery_status IN (${PREVIOUS_STATUSES.map((s) => `'${s}'`).join(',')})`,
    )
    expect(after.indexes).toEqual(before.indexes)
  })

  it('stores accepted with how it is held, and still refuses what nobody declared', () => {
    const db = previousDatabase()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    db.prepare(
      "UPDATE messages SET delivery_status = 'accepted', delivery_held = 'durable' WHERE id = 'm-typed'",
    ).run()
    db.prepare(
      "UPDATE messages SET delivery_status = 'accepted', delivery_held = 'memory' WHERE id = 'm-typing'",
    ).run()
    expect(
      db
        .prepare(
          "SELECT id, delivery_status, delivery_held FROM messages WHERE delivery_status = 'accepted' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: 'm-typed', delivery_status: 'accepted', delivery_held: 'durable' },
      { id: 'm-typing', delivery_status: 'accepted', delivery_held: 'memory' },
    ])
    expect(() =>
      db.prepare("UPDATE messages SET delivery_status = 'queued' WHERE id = 'm-stored'").run(),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare("UPDATE messages SET delivery_held = 'disk' WHERE id = 'm-stored'").run(),
    ).toThrow(/CHECK/)
  })

  it('a second boot applies nothing and changes nothing', () => {
    const db = previousDatabase()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const rows = allRows(db)
    const tableShape = shape(db)
    expect(runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).toEqual([])
    expect(allRows(db)).toEqual(rows)
    expect(shape(db)).toEqual(tableShape)
  })
})
