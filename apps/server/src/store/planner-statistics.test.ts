/**
 * THE PLANNER HAS STATISTICS, AND THEY ARE NEVER WRITTEN INSIDE A TRANSACTION
 * [POD-6148, server data design §3 rule 3].
 *
 * A file-backed store analyses its database when it opens (the live database
 * had never been analysed: no `sqlite_stat1`) and runs `PRAGMA optimize` on a
 * timer. Both run on the executor's exclusive lane. These tests show the
 * statistics exist after boot, that a refresh asked for while a transaction is
 * open waits for it and runs with no transaction open, that one asked for from
 * inside a transaction is refused, and that the timer refreshes until close.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { ExclusiveInsideLeaseError, probeStatements, type StatementProbeHolder } from './executor'
import { PLANNER_STATISTICS_ROW_FLOOR } from '../migrations/store-lifecycle'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function fileStore(): Promise<{ store: SessionStore; database: SqlDatabase }> {
  const dir = mkdtempSync(join(tmpdir(), 'podium-planner-statistics-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = await openTestStore(join(dir, 'podium.db'))
  let closed = false
  const close = store.close.bind(store)
  store.close = async (persist) => {
    if (closed) return
    closed = true
    await close(persist)
  }
  cleanup.push(() => store.close())
  return { store, database: (store as unknown as { db: SqlDatabase }).db }
}

/**
 * Whether the connection is inside a transaction right now: `BEGIN` succeeds
 * only outside one. Called from a statement probe, while the exclusive lane
 * that ran the statement still holds the connection.
 */
function insideTransaction(database: SqlDatabase): boolean {
  try {
    database.exec('BEGIN')
  } catch {
    return true
  }
  database.exec('COMMIT')
  return false
}

interface Refresh {
  readonly sql: string
  readonly insideTransaction: boolean
  readonly at: number
}

/** Record every statistics statement the store runs from now on. */
function watchRefreshes(store: SessionStore, database: SqlDatabase): Refresh[] {
  const seen: Refresh[] = []
  const detach = probeStatements(store as unknown as StatementProbeHolder, (observation) => {
    if (!/^(PRAGMA optimize|ANALYZE)/i.test(observation.sql)) return
    seen.push({
      sql: observation.sql,
      insideTransaction: insideTransaction(database),
      at: performance.now(),
    })
  })
  cleanup.push(detach)
  return seen
}

describe('POD-6148 — planner statistics', () => {
  it('exist after boot', async () => {
    const { database } = await fileStore()
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'")
      .all()
    expect(table).toEqual([{ name: 'sqlite_stat1' }])
    // Boot analysed the tables the store seeds, a few rows each, and kept no
    // statistics for them: every one is below the floor (POD-6223).
    const kept = database.prepare('SELECT DISTINCT tbl FROM sqlite_stat1').all()
    expect(kept).toEqual([])
  })

  it('a refresh asked for during a transaction waits for it and runs outside it', async () => {
    const { store, database } = await fileStore()
    const refreshes = watchRefreshes(store, database)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let opened!: () => void
    const isOpen = new Promise<void>((resolve) => {
      opened = resolve
    })
    let committedAt = 0
    const transaction = store
      .transact(async () => {
        await store.users.earliestAdmin()
        opened()
        await gate
      })
      .then(() => {
        committedAt = performance.now()
      })
    await isOpen
    const refresh = store.refreshPlannerStatistics('periodic')
    // Give the refresh every chance to run early.
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(refreshes).toEqual([])
    release()
    await Promise.all([transaction, refresh])
    expect(refreshes[0]!.sql).toBe('PRAGMA optimize')
    expect(refreshes.every((r) => !r.insideTransaction)).toBe(true)
    expect(refreshes[0]!.at).toBeGreaterThanOrEqual(committedAt)
  })

  it('a refresh asked for from inside a transaction is refused', async () => {
    const { store, database } = await fileStore()
    const refreshes = watchRefreshes(store, database)
    await expect(
      store.transact(async () => await store.refreshPlannerStatistics('periodic')),
    ).rejects.toBeInstanceOf(ExclusiveInsideLeaseError)
    expect(refreshes).toEqual([])
  })

  it('the timer refreshes until the store closes', async () => {
    const { store, database } = await fileStore()
    const refreshes = watchRefreshes(store, database)
    store.startPlannerStatistics(10)
    const deadline = performance.now() + 5_000
    const optimizes = () => refreshes.filter((r) => r.sql === 'PRAGMA optimize').length
    while (optimizes() < 2 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(refreshes.length).toBeGreaterThanOrEqual(2)
    expect(optimizes()).toBeGreaterThanOrEqual(2)
    expect(refreshes.every((r) => !r.insideTransaction)).toBe(true)
    await store.close()
    const after = refreshes.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(refreshes.length).toBe(after)
  })
})

/** The runtime-event drain's list query (`runtimeEventsAfter` in `events.ts`), as the bench caught it. */
const DRAIN =
  "SELECT id, subject, payload FROM podium_events WHERE kind = 'session.runtime' AND id > ? ORDER BY id LIMIT 128"

function addEvents(database: SqlDatabase, count: number): void {
  const insert = database.prepare(
    'INSERT INTO podium_events (ts, kind, subject, repo_path, payload) VALUES (?, ?, ?, ?, ?)',
  )
  database.exec('BEGIN')
  for (let i = 0; i < count; i++) {
    // Mostly runtime events, as on a server with sessions running.
    insert.run(new Date(1_700_000_000_000 + i).toISOString(), i % 20 === 0 ? 'session.state' : 'session.runtime',
      `ses_${i % 20}`, '/repo', '{"t":"item"}')
  }
  database.exec('COMMIT')
}

const planOf = (database: SqlDatabase, sql: string): string[] =>
  (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0) as { detail: string }[]).map((row) => row.detail)

const statsOf = (database: SqlDatabase, table: string): string[] =>
  (database.prepare('SELECT stat FROM sqlite_stat1 WHERE tbl = ?').all(table) as { stat: string }[]).map(
    (row) => row.stat,
  )

describe('POD-6223 — a table analysed while tiny', () => {
  it('plans the runtime-event drain by index once it has grown', async () => {
    // The bench template: the server boots on a log of one event, so boot
    // analyses the table at one row, and the round then grows it.
    const { store, database } = await fileStore()
    addEvents(database, 1)
    await store.refreshPlannerStatistics('open')
    expect(statsOf(database, 'podium_events')).toEqual([])
    addEvents(database, 9_999)
    expect(planOf(database, DRAIN)).toEqual([
      'SEARCH podium_events USING INDEX idx_podium_events_kind (kind=? AND rowid>?)',
    ])
  })

  it('keeps the statistics of a table analysed at the floor', async () => {
    const { store, database } = await fileStore()
    addEvents(database, PLANNER_STATISTICS_ROW_FLOOR)
    await store.refreshPlannerStatistics('open')
    const stats = statsOf(database, 'podium_events')
    expect(stats.length).toBeGreaterThan(0)
    expect(stats.every((stat) => stat.startsWith(`${PLANNER_STATISTICS_ROW_FLOOR} `))).toBe(true)
    addEvents(database, 9_000)
    expect(planOf(database, DRAIN)).toEqual([
      'SEARCH podium_events USING INDEX idx_podium_events_kind (kind=? AND rowid>?)',
    ])
  })

  it('the periodic refresh analyses it once it has grown past the floor', async () => {
    const { store, database } = await fileStore()
    addEvents(database, 1)
    await store.refreshPlannerStatistics('open')
    addEvents(database, 9_999)
    // A query on the table, as the running server makes: plain optimize
    // re-analyses the tables this connection has read.
    database.prepare(DRAIN).all(0)
    await store.refreshPlannerStatistics('periodic')
    const stats = statsOf(database, 'podium_events')
    expect(stats.length).toBeGreaterThan(0)
    expect(stats.every((stat) => Number(stat.split(' ')[0]) >= PLANNER_STATISTICS_ROW_FLOOR)).toBe(true)
  })
})
