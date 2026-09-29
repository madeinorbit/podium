/**
 * THE MESSAGE DELIVERY LIFECYCLE, AGAINST THE REAL DATABASE (POD-4765).
 *
 * `MessageDelivery` in @podium/model is the table of allowed moves. These tests
 * hold the store to it:
 *
 *  - the table walker drives the repository's one guarded write for EVERY
 *    (from, to) pair, so a move the table does not list is refused by the SQL,
 *    not only by review;
 *  - the CHECK constraint admits exactly the machine's states;
 *  - the migrations turn legacy rows into the new statuses, including the
 *    sub-state that used to hide in `injected_at`, and then drop the legacy
 *    column (POD-4787);
 *  - nothing outside the repository writes the status, and inside it only the
 *    guarded move does (the grep proof).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  asThreadId,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_HELD,
  MessageDelivery,
  type MessageDeliveryStatus,
  type MoveOutcome,
  walkMoves,
} from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { MessagesRepository } from './messages'
import type { MessageRow } from './types'

const stageQueries = (database: Parameters<typeof createBunStoreExecutor>[0]['database']) => {
  const stage = createBunStoreExecutor({ database }).queries
  if (!stage) throw new Error('the synchronous query capability is absent on this handle')
  return stage
}

let db: SqlDatabase
let messages: MessagesRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  messages = new MessagesRepository(stageQueries(db))
})

function row(id: string): MessageRow {
  return {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: null,
    toKind: 'issue',
    toId: 'iss_target',
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: id,
    expiresAt: null,
    createdAt: 't0',
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    expectsResponse: false,
  }
}

/** Plant a row in `status` directly: the walker is about the next move. */
async function planted(id: string, status: MessageDeliveryStatus): Promise<void> {
  await messages.addMessage(row(id))
  db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run(status, id)
}

const statusOf = (id: string) =>
  db.prepare('SELECT delivery_status AS d FROM messages WHERE id = ?').get(id) as { d: string }

/** The repository's one guarded write, which every public status method uses. */
const move = (id: string, to: MessageDeliveryStatus): Promise<MoveOutcome<MessageDeliveryStatus>> =>
  (
    messages as unknown as {
      move(id: string, to: MessageDeliveryStatus): Promise<MoveOutcome<MessageDeliveryStatus>>
    }
  ).move(id, to)

describe('the table walker', () => {
  it('applies every listed move, answers "already there" for a repeat, refuses every other', async () => {
    let n = 0
    const moved: string[] = []
    const mismatches = await walkMoves(MessageDelivery, async (from, to) => {
      const id = `m${n++}`
      await planted(id, from)
      const outcome = await move(id, to)
      // The outcome is not the whole proof: the ROW must agree with it.
      const after = statusOf(id).d
      if (outcome.kind === 'applied') {
        moved.push(`${from}→${to}`)
        expect(after, `${from}→${to}`).toBe(to)
      } else {
        expect(after, `${from}→${to}`).toBe(from)
      }
      return outcome
    })
    expect(mismatches).toEqual([])
    // The walk really exercised the table rather than refusing everything.
    const edges = MessageDelivery.states.flatMap((from) =>
      MessageDelivery.next(from).map((to) => `${from}→${to}`),
    )
    expect(moved.sort()).toEqual(edges.sort())
  })

  it('refuses a move on a row that does not exist, and says so', async () => {
    expect(await move('absent', 'confirmed')).toEqual({ kind: 'refused', current: null })
  })

  it('never walks a confirmed row back — the old requeue edge is gone', async () => {
    await planted('c', 'confirmed')
    for (const to of MESSAGE_DELIVERY_STATUSES.filter((s) => s !== 'confirmed')) {
      expect(await move('c', to)).toEqual({ kind: 'refused', current: 'confirmed' })
    }
    expect(statusOf('c').d).toBe('confirmed')
  })
})

describe('accepted, and how the program holds it (POD-4885)', () => {
  const S = 'sess_to' as Parameters<MessagesRepository['markAccepted']>[1]
  const OTHER = 'sess_other' as Parameters<MessagesRepository['markAccepted']>[1]
  const heldOf = (id: string) =>
    db.prepare('SELECT delivery_held AS h FROM messages WHERE id = ?').get(id) as {
      h: string | null
    }

  it('moves a typed message to accepted and records how it is held, once', async () => {
    await planted('a', 'typed')
    db.prepare("UPDATE messages SET delivered_to = 'sess_to' WHERE id = 'a'").run()
    expect(await messages.markAccepted('a', S, 'durable', 't1')).toMatchObject({ kind: 'applied' })
    expect(statusOf('a').d).toBe('accepted')
    expect(heldOf('a').h).toBe('durable')
    expect(await messages.getMessage('a')).toMatchObject({
      deliveryStatus: 'accepted',
      held: 'durable',
    })
    // A repeat with another kind changes nothing: the first report stands.
    expect((await messages.markAccepted('a', S, 'memory', 't2')).kind).not.toBe('applied')
    expect(heldOf('a').h).toBe('durable')
  })

  it('is refused for a session the message was not handed to', async () => {
    await planted('b', 'typed')
    db.prepare("UPDATE messages SET delivered_to = 'sess_to' WHERE id = 'b'").run()
    expect((await messages.markAccepted('b', OTHER, 'memory', 't1')).kind).not.toBe('applied')
    expect(statusOf('b').d).toBe('typed')
    expect(heldOf('b').h).toBeNull()
  })

  it('never moves a durably held message to unknown; a memory-held one still goes', async () => {
    await planted('durable', 'typed')
    await planted('memory', 'typed')
    db.prepare(
      "UPDATE messages SET delivered_to = 'sess_to' WHERE id IN ('durable', 'memory')",
    ).run()
    await messages.markAccepted('durable', S, 'durable', 't1')
    await messages.markAccepted('memory', S, 'memory', 't1')

    expect(await messages.markUnknown('durable', S)).toEqual({
      kind: 'refused',
      current: 'accepted',
    })
    expect(statusOf('durable').d).toBe('accepted')

    expect(await messages.markUnknown('memory', S)).toMatchObject({ kind: 'applied' })
    expect(statusOf('memory').d).toBe('unknown')
    // Kept after the move: the message still says the program had taken it.
    expect(heldOf('memory').h).toBe('memory')
  })

  it('still confirms or fails a durably held message on a report', async () => {
    await planted('c', 'accepted')
    db.prepare(
      "UPDATE messages SET delivered_to = 'sess_to', delivery_held = 'durable' WHERE id = 'c'",
    ).run()
    expect(await move('c', 'confirmed')).toMatchObject({ kind: 'applied' })
    await planted('f', 'accepted')
    db.prepare(
      "UPDATE messages SET delivered_to = 'sess_to', delivery_held = 'durable' WHERE id = 'f'",
    ).run()
    expect(await move('f', 'failed')).toMatchObject({ kind: 'applied' })
  })
})

describe('the CHECK constraint', () => {
  it('admits exactly the machine states', () => {
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
        .get() as {
        sql: string
      }
    ).sql
    const check = /delivery_status IN \(([^)]*)\)/.exec(sql)?.[1]
    expect(check?.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([
      ...MESSAGE_DELIVERY_STATUSES,
    ])
  })

  it('schema.ts declares the same list the migration applied', () => {
    const schema = readFileSync(join(import.meta.dirname, '../migrations/schema.ts'), 'utf8')
    const check = /delivery_status IN \(([^)]*)\)/.exec(schema)?.[1]
    expect(check?.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([
      ...MESSAGE_DELIVERY_STATUSES,
    ])
  })

  it('admits exactly the held kinds, in schema.ts and in the database', () => {
    const table = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
        .get() as { sql: string }
    ).sql
    const schema = readFileSync(join(import.meta.dirname, '../migrations/schema.ts'), 'utf8')
    for (const source of [table, schema]) {
      const check = /delivery_held IN \(([^)]*)\)/.exec(source)?.[1]
      expect(check?.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...MESSAGE_HELD])
    }
  })

  it('refuses a value outside it', async () => {
    await messages.addMessage(row('x'))
    expect(() =>
      db.prepare("UPDATE messages SET delivery_status = 'queued' WHERE id = 'x'").run(),
    ).toThrow(/CHECK/)
  })
})

describe('the migration', () => {
  it('maps every legacy row, and the injected sub-state becomes dispatched', () => {
    const legacy = openDatabase(':memory:')
    const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.includes('message-delivery-status'))
    expect(cut).toBeGreaterThan(0)
    runDrizzleMigrations(legacy, DRIZZLE_MIGRATIONS.slice(0, cut))
    const insert = legacy.prepare(
      `INSERT INTO messages (id, thread_id, from_kind, to_kind, to_id, body, created_at, status, injected_at, read_at)
       VALUES (?, ?, 'agent', 'issue', 'iss_t', 'b', 't0', ?, ?, ?)`,
    )
    const cases: Array<[string, string | null, string | null, MessageDeliveryStatus]> = [
      ['queued', null, null, 'stored'],
      ['queued', 't1', null, 'dispatched'],
      ['delivered', null, null, 'confirmed'],
      ['delivered', 't1', null, 'confirmed'],
      ['read', 't1', 't2', 'confirmed'],
      ['dead_letter', null, null, 'failed'],
      ['dead_letter', 't1', null, 'failed'],
      ['expired', null, null, 'expired'],
      ['cancelled', null, null, 'cancelled'],
    ]
    cases.forEach(([status, injectedAt, readAt], i) => {
      insert.run(`m${i}`, `m${i}`, status, injectedAt, readAt)
    })
    runDrizzleMigrations(legacy, DRIZZLE_MIGRATIONS)
    cases.forEach(([status, injectedAt, , expected], i) => {
      const after = legacy
        .prepare('SELECT delivery_status AS d FROM messages WHERE id = ?')
        .get(`m${i}`) as { d: string }
      expect(after, `${status} injected=${injectedAt}`).toEqual({ d: expected })
    })
  })
})

describe('every status write goes through the guarded move (the grep proof)', () => {
  const SERVER_SRC = join(import.meta.dirname, '..')
  const REPO = join(SERVER_SRC, '../../..')
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' || entry.name === 'drizzle' ? [] : sources(path)
      }
      // The generated migration manifest carries the migrations' own SQL.
      return entry.name.endsWith('.ts') &&
        !entry.name.includes('.test.') &&
        !entry.name.endsWith('.generated.ts')
        ? [path]
        : []
    })
  const code = (path: string) =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

  it('no production file but the repository updates the messages table', () => {
    const writers = [
      ...sources(SERVER_SRC),
      ...sources(join(REPO, 'packages/janitor/src')),
      ...sources(join(REPO, 'apps/daemon/src')),
    ].filter((path) =>
      /\.update\(messagesTable\)|\.update\(messages\)|UPDATE\s+`?messages`?\s+SET/i.test(
        code(path),
      ),
    )
    expect(writers.map((path) => relative(REPO, path))).toEqual([
      'apps/server/src/store/messages.ts',
    ])
  })

  it('inside the repository, only the guarded move sets delivery_status', () => {
    const source = code(join(SERVER_SRC, 'store/messages.ts'))
    // `deliveryStatus: <value>` inside an insert or update: the insert's initial
    // `stored` and the move's `to`. Reads (`MESSAGE_QUEUE_COLUMNS`, the select
    // in the move's read) name the column, never assign a value.
    const assignments = [...source.matchAll(/deliveryStatus: (?!messagesTable)([^,\n}]+)/g)].map(
      (m) => m[1]!.trim(),
    )
    expect(assignments.sort()).toEqual(["'stored'", 'r.deliveryStatus', 'to'].sort())
    // The move is the one `moveStatus` call. Of the table's UPDATEs, exactly
    // one sets delivery_status (the move); the others (read stamp, ack,
    // reminder) move no status.
    expect([...source.matchAll(/moveStatus\(/g)]).toHaveLength(1)
    const updates = [
      ...source.matchAll(/\.update\(messagesTable\)\s*\.set\(\{([\s\S]*?)\}\)/g),
    ].map((m) => m[1]!)
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates.filter((set) => /deliveryStatus/.test(set))).toHaveLength(1)
  })
})
