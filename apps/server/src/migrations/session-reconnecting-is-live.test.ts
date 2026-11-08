/**
 * `reconnecting` LEAVES THE STORED SESSION STATUS (POD-6646, ADR 12 D1).
 *
 * The migration rewrites every stored `reconnecting` to `live`: the agent was
 * meant to keep running and only the daemon link had dropped. It does the same
 * to the session payloads in the change log, leaves every other status and
 * entity alone, and rotates the feed epoch so saved replicas rebuild.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

it('rewrites stored reconnecting sessions and their change-log payloads to live', () => {
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_session-reconnecting-is-live'))
  expect(cut).toBeGreaterThan(0)
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
    db.prepare(`INSERT INTO feed_identity (singleton, feed_id, epoch, minted_at)
      VALUES (1, 'feed', 'before', 1)`).run()
    const owner = (
      db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as {
        id: string
      }
    ).id
    const session = db.prepare(
      `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, status, durable_label,
         created_at, last_active_at, machine_id, owner_user_id)
       VALUES (?, 'claude-code', '/p', ?, 'spawn', ?, ?, '2026-11-01', '2026-11-01', 'local', ?)`,
    )
    const statuses = ['reconnecting', 'live', 'starting', 'hibernated', 'exited'] as const
    for (const status of statuses)
      session.run(`s-${status}`, `t-${status}`, status, `l-${status}`, owner)

    const payload = (status: string) =>
      JSON.stringify({ sessionId: `s-${status}`, status, title: 'kept' })
    const change = db.prepare(
      'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, 1)',
    )
    const latest = db.prepare(
      'INSERT INTO change_latest (entity, entity_id, seq, payload) VALUES (?, ?, ?, ?)',
    )
    statuses.forEach((status, i) => {
      change.run('session', `s-${status}`, 'upsert', payload(status))
      latest.run('session', `s-${status}`, i + 1, payload(status))
    })
    // Another entity that happens to carry the word, and a removal with no payload.
    change.run('machine', 'm1', 'upsert', JSON.stringify({ id: 'm1', status: 'reconnecting' }))
    latest.run('machine', 'm1', 99, JSON.stringify({ id: 'm1', status: 'reconnecting' }))
    change.run('session', 's-gone', 'remove', 'null')

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))

    expect(db.prepare('SELECT id, status FROM sessions ORDER BY id').all()).toEqual([
      { id: 's-exited', status: 'exited' },
      { id: 's-hibernated', status: 'hibernated' },
      { id: 's-live', status: 'live' },
      { id: 's-reconnecting', status: 'live' },
      { id: 's-starting', status: 'starting' },
    ])
    const sessionPayloads = (table: 'changes' | 'change_latest') =>
      (
        db
          .prepare(
            `SELECT entity_id, payload FROM ${table} WHERE entity = 'session' AND payload != 'null' ORDER BY entity_id`,
          )
          .all() as { entity_id: string; payload: string }[]
      ).map((r) => [r.entity_id, JSON.parse(r.payload)])
    for (const table of ['changes', 'change_latest'] as const) {
      expect(sessionPayloads(table)).toEqual([
        ['s-exited', { sessionId: 's-exited', status: 'exited', title: 'kept' }],
        ['s-hibernated', { sessionId: 's-hibernated', status: 'hibernated', title: 'kept' }],
        ['s-live', { sessionId: 's-live', status: 'live', title: 'kept' }],
        ['s-reconnecting', { sessionId: 's-reconnecting', status: 'live', title: 'kept' }],
        ['s-starting', { sessionId: 's-starting', status: 'starting', title: 'kept' }],
      ])
      expect(
        JSON.parse(
          (
            db.prepare(`SELECT payload FROM ${table} WHERE entity = 'machine'`).get() as {
              payload: string
            }
          ).payload,
        ),
      ).toEqual({ id: 'm1', status: 'reconnecting' })
    }
    const identity = db.prepare('SELECT feed_id, epoch FROM feed_identity').get()
    expect(identity).toEqual({
      feed_id: 'feed',
      epoch: expect.stringMatching(/^session-reconnecting-is-live-/),
    })

    // A second boot applies nothing.
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    expect(db.prepare('SELECT feed_id, epoch FROM feed_identity').get()).toEqual(identity)
  } finally {
    db.close()
  }
})
