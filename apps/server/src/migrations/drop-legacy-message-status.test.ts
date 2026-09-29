/**
 * THE LEGACY `messages.status` COLUMN IS GONE (POD-4787).
 *
 * The migration rebuilds `messages` without the column that mirrored
 * `delivery_status` for a rollback that is refused by design. These tests run it
 * on a database that has the old column and real rows in it:
 *
 *  - every row survives with the delivery status the POD-4765 migration gave it,
 *    its read stamp and every other column exactly as they were;
 *  - the rebuilt table is the old one minus the column, its CHECK and the five
 *    indexes built on it — nothing else added, lost or reworded — and matches
 *    what schema.ts declares;
 *  - every query the repository and the janitor make still has an index;
 *  - a second boot applies nothing and changes nothing.
 */

import { MessageExpiryReader } from '@podium/janitor'
import { asIssueId, asSessionId, type MessageDeliveryStatus } from '@podium/model'
import { bunSqliteClient, openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it, vi } from 'vitest'
import { createBunStoreExecutor } from '../store/executor'
import { MessagesRepository } from '../store/messages'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { messages as messagesTable } from './schema'

const DROP = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_drop-legacy-message-status'))
const DELIVERY = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_message-delivery-status'))

const LEGACY_INDEXES = [
  'idx_messages_expiry_explicit',
  'idx_messages_expiry_implicit',
  'idx_messages_queue_order',
  'idx_messages_recipient',
  'idx_messages_recipient_order',
]

/**
 * Rows of every legacy status, written the way the old code wrote them, before
 * the delivery-status migration: `[id, status, injected_at, read_at, the delivery
 * status POD-4765 turns it into]`. Written out, not derived: a test that asked
 * the migration for its expectation could never fail.
 */
const PRE_DELIVERY: Array<[string, string, string | null, string | null, MessageDeliveryStatus]> = [
  ['held', 'queued', null, null, 'stored'],
  ['handed-on', 'queued', 't1', null, 'dispatched'],
  ['echoed', 'delivered', 't1', null, 'confirmed'],
  ['pulled', 'read', 't1', 't2', 'confirmed'],
  ['read-no-inject', 'read', null, 't2', 'confirmed'],
  ['gone', 'dead_letter', null, null, 'failed'],
  ['cut-off', 'dead_letter', 't1', null, 'failed'],
  ['stale', 'expired', null, null, 'expired'],
  ['withdrawn', 'cancelled', null, null, 'cancelled'],
]

/** Rows the dual-write release wrote: a delivery status only it knows, with the
 *  legacy mirror beside it. */
const DUAL_WRITE: Array<[string, MessageDeliveryStatus, string]> = [
  ['on-machine', 'reached-machine', 'queued'],
  ['typing', 'typing', 'queued'],
  ['typed', 'typed', 'queued'],
  ['lost-track', 'unknown', 'queued'],
  ['confirmed-read', 'confirmed', 'read'],
]

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
      .get() as {
      sql: string
    }
  ).sql
  // Named CHECKs, table-level or on a column (an ADD COLUMN carries its own),
  // each body read to its balancing parenthesis.
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

/** A database one migration short of the drop, holding rows of every legacy status. */
function legacyDatabase(): SqlDatabase {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, DELIVERY))
  const insert = db.prepare(
    `INSERT INTO messages (id, thread_id, from_kind, from_session, from_issue, to_kind, to_id,
       urgency, lifecycle, body, expires_at, created_at, status, delivered_at, delivered_to,
       acked_by, hop, clamped_from, injected_at, read_at, dead_lettered_at)
     VALUES (?, ?, 'agent', 'sess_from', 'iss_from', 'session', 'sess_to', 'next-turn', 'wait', ?,
       ?, ?, ?, ?, ?, ?, 2, '{"urgency":"interrupt"}', ?, ?, ?)`,
  )
  PRE_DELIVERY.forEach(([id, status, injectedAt, readAt], i) => {
    insert.run(
      id,
      `thread-${id}`,
      `body of ${id}`,
      i % 2 === 0 ? null : '2026-07-20T00:00:00.000Z',
      `2026-07-0${1 + (i % 9)}T00:00:00.000Z`,
      status,
      status === 'delivered' || status === 'read' ? 't1' : null,
      injectedAt ? 'sess_to' : null,
      status === 'read' ? 'msg_ack' : null,
      injectedAt,
      readAt,
      status === 'dead_letter' ? 't3' : null,
    )
  })
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, DROP))
  const dual = db.prepare(
    `INSERT INTO messages (id, thread_id, from_kind, to_kind, to_id, body, created_at, status,
       delivery_status, injected_at, read_at, transcript_item_id, notice_dismissed_at,
       retract_requested_at, attachments_json, expects_response)
     VALUES (?, ?, 'operator', 'session', 'sess_to', 'b', '2026-07-10T00:00:00.000Z', ?, ?, 't1',
       ?, 'item-1', 't4', 't5', '[]', 1)`,
  )
  for (const [id, delivery, status] of DUAL_WRITE) {
    dual.run(id, `thread-${id}`, status, delivery, status === 'read' ? 't2' : null)
  }
  return db
}

const withoutStatus = ({ status: _status, ...rest }: Record<string, unknown>) => rest

describe('the drop-legacy-message-status migration', () => {
  it('sits after the delivery-status migration, and is the newest one touching messages', () => {
    expect(DELIVERY).toBeGreaterThan(0)
    expect(DROP).toBeGreaterThan(DELIVERY)
  })

  it('carries every row across with its delivery status, read stamp and every other column', () => {
    const db = legacyDatabase()
    const before = allRows(db)
    expect(before).toHaveLength(PRE_DELIVERY.length + DUAL_WRITE.length)
    expect(before[0]).toHaveProperty('status')

    const applied = runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expect(applied).toEqual(DRIZZLE_MIGRATIONS.slice(DROP).map((m) => m.name))

    const after = allRows(db)
    // Exactly the old rows minus the one column: nothing lost, nothing rewritten.
    expect(after).toEqual(before.map(withoutStatus))
    for (const row of after) expect(row).not.toHaveProperty('status')

    const byId = new Map(after.map((row) => [row.id as string, row]))
    for (const [id, status, injectedAt, readAt, expected] of PRE_DELIVERY) {
      expect(byId.get(id), `${status} injected=${injectedAt}`).toMatchObject({
        delivery_status: expected,
        injected_at: injectedAt,
        read_at: readAt,
      })
    }
    for (const [id, delivery, status] of DUAL_WRITE) {
      expect(byId.get(id), id).toMatchObject({
        delivery_status: delivery,
        read_at: status === 'read' ? 't2' : null,
        transcript_item_id: 'item-1',
        notice_dismissed_at: 't4',
        retract_requested_at: 't5',
      })
    }
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    expect(db.prepare('PRAGMA foreign_key_check(messages)').all()).toEqual([])
  })

  it('rebuilds the table as the old one minus the column, its CHECK and its five indexes', () => {
    const db = legacyDatabase()
    const before = shape(db)
    // The fixture really has what the migration removes.
    expect(before.columns).toHaveProperty('status')
    expect(before.checks).toHaveProperty('messages_check_10')
    expect(Object.keys(before.indexes)).toEqual(expect.arrayContaining(LEGACY_INDEXES))

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const after = shape(db)

    const { status: _column, ...columns } = before.columns
    expect(after.columns).toEqual(columns)
    const { messages_check_10: _check, ...checks } = before.checks
    expect(after.checks).toEqual(checks)
    expect(Object.keys(after.checks).sort()).toEqual([
      'messages_check_5',
      'messages_check_6',
      'messages_check_7',
      'messages_check_8',
      'messages_check_9',
      'messages_delivery_status',
    ])
    const indexes = Object.fromEntries(
      Object.entries(before.indexes).filter(([name]) => !LEGACY_INDEXES.includes(name)),
    )
    expect(after.indexes).toEqual(indexes)
    // Nothing left in the table's definition names the column.
    const definition = [...Object.values(after.checks), ...Object.values(after.indexes)].join('\n')
    expect(definition).not.toMatch(/(?<![\w_])[`"]?status[`"]?(?![\w_])/)
  })

  it('leaves exactly the columns and indexes schema.ts declares', () => {
    const db = legacyDatabase()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const after = shape(db)
    const config = getTableConfig(messagesTable)
    expect(Object.keys(after.columns).sort()).toEqual(config.columns.map((c) => c.name).sort())
    expect(Object.keys(after.indexes).sort()).toEqual(
      config.indexes.map((i) => i.config.name).sort(),
    )
    expect(Object.keys(after.checks).sort()).toEqual(config.checks.map((c) => c.name).sort())
  })

  it('a second boot applies nothing and changes nothing', () => {
    const db = legacyDatabase()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const rows = allRows(db)
    const tableShape = shape(db)
    expect(runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).toEqual([])
    expect(allRows(db)).toEqual(rows)
    expect(shape(db)).toEqual(tableShape)
  })

  it('keeps the janitor expiry scans on their indexes', async () => {
    const db = legacyDatabase()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const prepare = vi.spyOn(db, 'prepare')
    const due = await new MessageExpiryReader(db).read({
      now: '2026-07-21T00:00:00.000Z',
      waitImplicitCutoff: '2026-07-31T00:00:00.000Z',
      limit: 100,
    })
    // Only the row the server still holds is a candidate; the rest were handed
    // on or ended, so they cannot expire.
    expect(due.map((row) => row.messageId)).toEqual(['held'])
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join('\n')
    const scans = prepare.mock.calls.map(([sql]) => sql).filter((sql) => /FROM messages/.test(sql))
    expect(scans).toHaveLength(2)
    expect(scans.map(plan).join('\n')).toMatch(
      /SEARCH messages USING (COVERING )?INDEX idx_messages_delivery_expiry_implicit/,
    )
    expect(scans.map(plan).join('\n')).toMatch(
      /SEARCH messages USING (COVERING )?INDEX idx_messages_delivery_expiry_explicit/,
    )
  })

  it('keeps every repository read that had an index on one', async () => {
    const legacy = legacyDatabase()
    const upgraded = legacyDatabase()
    runDrizzleMigrations(upgraded, DRIZZLE_MIGRATIONS)
    const raw = bunSqliteClient(upgraded)
    if (!raw) throw new Error('expected a bun:sqlite handle')
    const queries = createBunStoreExecutor({ database: upgraded }).queries
    if (!queries) throw new Error('the synchronous query capability is absent on this handle')
    const repo = new MessagesRepository(queries)

    const prepare = vi.spyOn(raw, 'prepare')
    const session = asSessionId('sess_to')
    const issue = asIssueId('iss_from')
    const recipients = [
      { kind: 'session' as const, id: 'sess_to' },
      { kind: 'issue' as const, id: 'iss_from' },
      { kind: 'operator' as const },
    ]
    await repo.loadWorldPending()
    await repo.getMessage('held')
    await repo.getMessages(['held', 'typed'])
    await repo.pendingForSessionProof(session, '2026-07-21T00:00:00.000Z')
    await repo.listLedger({ sessionId: session })
    await repo.listLedger({ issueId: issue })
    await repo.queuedPositionForSession(session, 'held')
    await repo.latestPendingOperatorForSession(session)
    await repo.countQueued()
    for (const to of recipients) {
      await repo.listMessagesFor(to)
      await repo.pendingForPage(to)
      await repo.listPendingSenders(to)
      await repo.pendingSummary(to)
      await repo.countPending(to)
      await repo.alreadyCommunicated('iss_from', to, '2026-07-01T00:00:00.000Z')
    }
    await repo.pendingSummaryForSession(issue, session)
    await repo.countPendingForSession(issue, session)
    await repo.listPendingSendersForSession(issue, session)
    await repo.listOpenBoundTo([session], issue)
    await repo.listOpenChat()
    await repo.listQueued()
    await repo.listQueuedPage()
    await repo.listDeliveredUnacked(session, '2026-07-21T00:00:00.000Z')
    await repo.listSettleNotifiable(session, '2026-07-21T00:00:00.000Z')

    const reads = [
      ...new Set(
        prepare.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => /^\s*select/i.test(sql) && /from "messages"/i.test(sql)),
      ),
    ]
    expect(reads.length).toBeGreaterThan(15)
    const plan = (db: SqlDatabase, sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .filter((detail) => /\bmessages\b/.test(detail))
    // A bare `SCAN messages` walks every row; anything else is an index.
    const fullScan = (details: string[]) => details.some((d) => /^SCAN messages$/.test(d.trim()))
    const regressions = reads.filter(
      (sql) => !fullScan(plan(legacy, sql)) && fullScan(plan(upgraded, sql)),
    )
    expect(regressions).toEqual([])
    // A read that leaned on a dropped index now leans on its delivery twin.
    const onLegacy = reads.filter((sql) =>
      plan(legacy, sql).some((d) =>
        LEGACY_INDEXES.some((name) => new RegExp(`INDEX ${name}\\b`).test(d)),
      ),
    )
    // Some reads really did lean on a dropped index: the comparison is not vacuous.
    expect(onLegacy.length).toBeGreaterThan(0)
    for (const sql of onLegacy) {
      expect(plan(upgraded, sql).join('\n'), sql).toMatch(/INDEX idx_messages_/)
    }
  })
})
