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
    // Boot wrote statistics for the tables that have rows (the store seeds a few).
    const rows = database.prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get() as { n: number }
    expect(rows.n).toBeGreaterThan(0)
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
    expect(refreshes.map((r) => r.sql)).toEqual(['PRAGMA optimize'])
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
    while (refreshes.length < 2 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(refreshes.length).toBeGreaterThanOrEqual(2)
    expect(refreshes.every((r) => r.sql === 'PRAGMA optimize' && !r.insideTransaction)).toBe(true)
    await store.close()
    const after = refreshes.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(refreshes.length).toBe(after)
  })
})
