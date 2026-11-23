/**
 * THE QUEUE'S ORDER BECOMES A COLUMN (POD-7075).
 *
 * `queued_messages` and `upstream_outbox` were read FIFO by (queued_at, rowid). The
 * migration `queue-order` adds `queue_order` and numbers the rows already there in exactly
 * that order: per session for the inbox, per workspace for the parked outbox. The fixture
 * is the real chain up to the migration, with rows inserted out of clock order and with
 * same-millisecond ties whose ids sort against their insertion order, so a numbering by
 * id or by clock alone fails here. Then the rest of the chain runs through the real migrator.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const ORDER = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_queue-order'))

let db: SqlDatabase

const queue = (workspace: string, id: string, session: string, queuedAt: number): void => {
  db.prepare(
    'INSERT INTO queued_messages (workspace_id, id, session_id, text, queued_at) VALUES (?, ?, ?, ?, ?)',
  ).run(workspace, id, session, `t-${id}`, queuedAt)
}

const park = (workspace: string, mutationId: string, queuedAt: number): void => {
  db.prepare(
    "INSERT INTO upstream_outbox (workspace_id, mutation_id, proc, input, queued_at) VALUES (?, ?, 'issues.update', '{}', ?)",
  ).run(workspace, mutationId, queuedAt)
}

beforeAll(() => {
  expect(ORDER).toBeGreaterThan(0)
  db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, ORDER))
  // Session s1 of `local`: a later clock first, then a same-millisecond tie written
  // z before a, then an earlier clock last.
  queue('local', 'm-20', 's1', 20)
  queue('local', 'z-10', 's1', 10)
  queue('local', 'a-10', 's1', 10)
  queue('local', 'm-5', 's1', 5)
  // Another session and another workspace number from 1 on their own.
  queue('local', 'other', 's2', 1)
  queue('ws-b', 'b-2', 's1', 2)
  queue('ws-b', 'b-1', 's1', 1)
  park('local', 'p-z', 7)
  park('local', 'p-a', 7)
  park('local', 'p-early', 3)
  park('ws-b', 'p-b', 9)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
})

describe('POD-7075 — the queue-order migration', () => {
  it('numbers each session inbox by (queued_at, rowid), from 1', () => {
    expect(
      db
        .prepare(
          'SELECT workspace_id, session_id, id, queue_order FROM queued_messages ORDER BY workspace_id, session_id, queue_order',
        )
        .all(),
    ).toEqual([
      { workspace_id: 'local', session_id: 's1', id: 'm-5', queue_order: 1 },
      { workspace_id: 'local', session_id: 's1', id: 'z-10', queue_order: 2 },
      { workspace_id: 'local', session_id: 's1', id: 'a-10', queue_order: 3 },
      { workspace_id: 'local', session_id: 's1', id: 'm-20', queue_order: 4 },
      { workspace_id: 'local', session_id: 's2', id: 'other', queue_order: 1 },
      { workspace_id: 'ws-b', session_id: 's1', id: 'b-1', queue_order: 1 },
      { workspace_id: 'ws-b', session_id: 's1', id: 'b-2', queue_order: 2 },
    ])
  })

  it('numbers the parked outbox per workspace by (queued_at, rowid)', () => {
    expect(
      db
        .prepare(
          'SELECT workspace_id, mutation_id, queue_order FROM upstream_outbox ORDER BY workspace_id, queue_order',
        )
        .all(),
    ).toEqual([
      { workspace_id: 'local', mutation_id: 'p-early', queue_order: 1 },
      { workspace_id: 'local', mutation_id: 'p-z', queue_order: 2 },
      { workspace_id: 'local', mutation_id: 'p-a', queue_order: 3 },
      { workspace_id: 'ws-b', mutation_id: 'p-b', queue_order: 1 },
    ])
  })

  it('reads one session in queue order through the index', () => {
    const plan = (
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM queued_messages WHERE workspace_id = 'local' AND session_id = 's1' ORDER BY queue_order",
        )
        .all() as { detail: string }[]
    ).map((r) => r.detail)
    expect(plan.join(' | ')).toContain('queued_messages_session')
    // The index answers the order: no sort step.
    expect(plan.join(' | ')).not.toContain('TEMP B-TREE')
  })
})
