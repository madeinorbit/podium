/**
 * ONE WRITE SLOT PER WORKSPACE [POD-6996, POD-6958 design 2.4].
 *
 * A driver that serialises each workspace's writers itself (Postgres, whose write
 * locks the workspace's `sync_feed` row first) declares `workspaceWrites`, and the
 * scheduler then keys a write's slot by its workspace. Every property here is about
 * what may or may not run BETWEEN two awaits, so the bodies park on barriers and the
 * test releases them in the order it wants, as in `executor.test.ts`.
 *
 * Each test names the failure it catches. The SQLite half is the oracle that the
 * single slot did not move: a driver that declares nothing still runs one write at
 * a time, whatever workspace each one names.
 */

import { asWorkspaceId } from '@podium/model'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  clonePgTestDatabase,
  connectPgTest,
  type PgTestClient,
  testStoreEngine,
} from '../../test-support/pg-test-database'
import { runRootStatementIn } from './context'
import type { DriverSession, LanePolicy, QueryClient, StoreDriver } from './driver'
import { NO_BUSY_RETRY, queryClientOver, UNBOUNDED_WRITE_BUDGET_MS } from './driver'
import {
  createStoreExecutor,
  GLOBAL_CONTEXT,
  type RootStoreExecutor,
  type StoreContext,
  workspaceContext,
} from './executor'
import { barrier, openHarness, settle } from './harness'
import { createPgStoreDriver } from './pg-driver'
import { createScheduler, type Scheduler } from './scheduler'

const A = workspaceContext(asWorkspaceId('ws_a'))
const B = workspaceContext(asWorkspaceId('ws_b'))
const C = workspaceContext(asWorkspaceId('ws_c'))

/** A driver whose sessions do nothing: only the scheduler's admission is under test. */
function laneDriver(lanes: LanePolicy): StoreDriver<QueryClient> {
  const session: DriverSession = {
    execute: async () => ({ rows: [] }),
    executeBatch: async (statements) => statements.map(() => ({ rows: [] })),
    begin: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    enterSavepoint: async () => undefined,
    releaseSavepoint: async () => undefined,
    rollbackToSavepoint: async () => undefined,
    close: async () => undefined,
  }
  return {
    kind: 'lane-fake',
    lanes,
    limits: { writeBudgetMs: UNBOUNDED_WRITE_BUDGET_MS, busyRetry: NO_BUSY_RETRY },
    open: async () => session,
    client: (route, routeBatch) => queryClientOver(route, routeBatch),
    close: async () => undefined,
  }
}

const open: Scheduler[] = []
function scheduler(lanes: LanePolicy): Scheduler {
  const made = createScheduler({ driver: laneDriver(lanes) })
  open.push(made)
  return made
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (s) => await s.close()))
})

/** A write body that records its start and end and parks until released. */
interface Parked {
  readonly done: Promise<void>
  release(): void
}

function parkedWrite(
  s: Scheduler,
  order: string[],
  name: string,
  context: StoreContext | undefined,
  lane: 'write' | 'read' = 'write',
): Parked {
  const gate = barrier()
  const done = s.run(
    lane,
    async () => {
      order.push(`${name}:start`)
      await gate.wait()
      order.push(`${name}:end`)
    },
    context,
  )
  return { done, release: () => gate.release() }
}

describe('per-workspace write slots', () => {
  it('runs write bodies of two workspaces at the same time', async () => {
    // Catches: the per-workspace driver still getting the process-wide single slot,
    // which serialises every workspace's writes behind one another.
    const s = scheduler({ readConcurrency: 3, workspaceWrites: 4 })
    const order: string[] = []
    const a = parkedWrite(s, order, 'a', A)
    const b = parkedWrite(s, order, 'b', B)
    await settle()
    expect(order).toEqual(['a:start', 'b:start'])
    b.release()
    await b.done
    a.release()
    await a.done
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end'])
  })

  it('never overlaps two write bodies of one workspace', async () => {
    // Catches: a slot keyed by lease rather than workspace, so a second writer of the
    // workspace reaches the database lock while the first holds it and waits there,
    // under the lock timeout, instead of in the FIFO.
    const s = scheduler({ readConcurrency: 3, workspaceWrites: 4 })
    const order: string[] = []
    const first = parkedWrite(s, order, 'a1', A)
    const second = parkedWrite(s, order, 'a2', A)
    await settle()
    expect(order).toEqual(['a1:start'])
    first.release()
    await first.done
    await settle()
    expect(order).toEqual(['a1:start', 'a1:end', 'a2:start'])
    second.release()
    await second.done
  })

  it('keeps FIFO order within a workspace, and a blocked workspace holds up no other', async () => {
    // Catches: a newcomer of workspace A overtaking an earlier queued writer of A, and
    // head-of-line blocking, where B's writer waits behind A's queue.
    const s = scheduler({ readConcurrency: 3, workspaceWrites: 4 })
    const order: string[] = []
    const a1 = parkedWrite(s, order, 'a1', A)
    const a2 = parkedWrite(s, order, 'a2', A)
    const a3 = parkedWrite(s, order, 'a3', A)
    const b1 = parkedWrite(s, order, 'b1', B)
    await settle()
    expect(order, 'b1 starts beside a1; a2 and a3 wait for their workspace').toEqual([
      'a1:start',
      'b1:start',
    ])
    // Released out of order: the queue, not the release order, decides.
    a3.release()
    a2.release()
    a1.release()
    b1.release()
    await Promise.all([a1.done, a2.done, a3.done, b1.done])
    const ofA = order.filter((entry) => entry.startsWith('a'))
    expect(ofA).toEqual(['a1:start', 'a1:end', 'a2:start', 'a2:end', 'a3:start', 'a3:end'])
  })

  it('bounds the write slots held at once, and admits in queue order when one frees', async () => {
    // Catches: an unbounded slot count, which on Postgres asks the pool for more
    // connections than it has and leaves reads none.
    const s = scheduler({ readConcurrency: 3, workspaceWrites: 2 })
    const order: string[] = []
    const a1 = parkedWrite(s, order, 'a1', A)
    const b1 = parkedWrite(s, order, 'b1', B)
    const c1 = parkedWrite(s, order, 'c1', C)
    const a2 = parkedWrite(s, order, 'a2', A)
    await settle()
    expect(order, 'two slots: c1 waits for one to free').toEqual(['a1:start', 'b1:start'])
    b1.release()
    await b1.done
    await settle()
    expect(order.slice(-1), 'the freed slot goes to the earliest waiter that can use it').toEqual([
      'c1:start',
    ])
    a1.release()
    await a1.done
    await settle()
    expect(order.slice(-1)).toEqual(['a2:start'])
    c1.release()
    a2.release()
    await Promise.all([c1.done, a2.done])
  })

  it('makes exclusive wait for every workspace, then run alone', async () => {
    // Catches: exclusive checking only one slot, so it starts while another
    // workspace's write is open; and a newcomer of an idle workspace slipping past it.
    const s = scheduler({ readConcurrency: 3, workspaceWrites: 4 })
    const order: string[] = []
    const a = parkedWrite(s, order, 'a', A)
    const b = parkedWrite(s, order, 'b', B)
    const exclusiveGate = barrier()
    const exclusive = s.run('exclusive', async () => {
      order.push('exclusive:start')
      await exclusiveGate.wait()
      order.push('exclusive:end')
    })
    await settle()
    const c = parkedWrite(s, order, 'c', C)
    const g = parkedWrite(s, order, 'global', GLOBAL_CONTEXT)
    const read = parkedWrite(s, order, 'read', undefined, 'read')
    await settle()
    expect(order, 'nothing passes a queued exclusive').toEqual(['a:start', 'b:start'])

    a.release()
    await a.done
    await settle()
    expect(order.includes('exclusive:start'), 'b is still open').toBe(false)
    b.release()
    await b.done
    await settle()
    expect(order.slice(-1)).toEqual(['exclusive:start'])

    await settle()
    expect(order.slice(-1), 'the exclusive body runs alone').toEqual(['exclusive:start'])
    exclusiveGate.release()
    await exclusive
    await settle()
    expect(order.slice(-4)).toEqual(['exclusive:end', 'c:start', 'global:start', 'read:start'])
    c.release()
    g.release()
    read.release()
    await Promise.all([c.done, g.done, read.done])
  })

  it('makes a write of any workspace that arrives during an exclusive body wait for it', async () => {
    // Catches: admission skipping the barrier for a write whose own slot is free.
    const s = scheduler({ readConcurrency: 3, workspaceWrites: 4 })
    const order: string[] = []
    const entered = barrier()
    const gate = barrier()
    const exclusive = s.run('exclusive', async () => {
      order.push('exclusive:start')
      entered.release()
      await gate.wait()
      order.push('exclusive:end')
    })
    await entered.wait()
    const a = parkedWrite(s, order, 'a', A)
    const g = parkedWrite(s, order, 'global', GLOBAL_CONTEXT)
    await settle()
    expect(order).toEqual(['exclusive:start'])
    gate.release()
    await exclusive
    await settle()
    expect(order).toEqual(['exclusive:start', 'exclusive:end', 'a:start', 'global:start'])
    a.release()
    g.release()
    await Promise.all([a.done, g.done])
  })

  it('gives global-context writes one slot of their own beside the workspaces', async () => {
    // Catches: global work sharing a workspace's slot (it would queue behind that
    // workspace) or getting none (two global writes would overlap).
    const s = scheduler({ readConcurrency: 3, workspaceWrites: 4 })
    const order: string[] = []
    const g1 = parkedWrite(s, order, 'g1', GLOBAL_CONTEXT)
    const g2 = parkedWrite(s, order, 'g2', undefined)
    const a = parkedWrite(s, order, 'a', A)
    await settle()
    expect(order, 'a runs beside g1; g2, named by no context, is global and waits').toEqual([
      'g1:start',
      'a:start',
    ])
    g1.release()
    await g1.done
    await settle()
    expect(order.slice(-1)).toEqual(['g2:start'])
    g2.release()
    a.release()
    await Promise.all([g2.done, a.done])
  })

  it('keys a root statement by the workspace its handle names', async () => {
    // Catches: a root write through a workspace handle (no transaction, so no frame)
    // falling onto the global slot, where it runs beside its own workspace's open
    // transaction and waits on the database lock instead of in the FIFO.
    const s = scheduler({ readConcurrency: 3, workspaceWrites: 4 })
    const order: string[] = []
    const transaction = parkedWrite(s, order, 'a-transaction', A)
    const root = runRootStatementIn(A, () => parkedWrite(s, order, 'a-root', undefined))
    const other = runRootStatementIn(B, () => parkedWrite(s, order, 'b-root', undefined))
    await settle()
    expect(order).toEqual(['a-transaction:start', 'b-root:start'])
    transaction.release()
    await transaction.done
    await settle()
    expect(order.slice(-1)).toEqual(['a-root:start'])
    root.release()
    other.release()
    await Promise.all([root.done, other.done])
  })

  it('leaves reads on their own lane beside the write slots', async () => {
    // Catches: reads counted against the write bound.
    const s = scheduler({ readConcurrency: 2, workspaceWrites: 1 })
    const order: string[] = []
    const a = parkedWrite(s, order, 'a', A)
    const r1 = parkedWrite(s, order, 'r1', A, 'read')
    const r2 = parkedWrite(s, order, 'r2', undefined, 'read')
    const b = parkedWrite(s, order, 'b', B)
    await settle()
    expect(order).toEqual(['a:start', 'r1:start', 'r2:start'])
    for (const parked of [a, r1, r2, b]) parked.release()
    await Promise.all([a.done, r1.done, r2.done, b.done])
    expect(order.slice(-2)).toEqual(['b:start', 'b:end'])
  })

  it('puts reads without a lane of their own on the global slot', async () => {
    // `readConcurrency: 0` means reads take a write slot. With slots per workspace
    // that is the global one: a read needs no workspace's lock.
    const s = scheduler({ readConcurrency: 0, workspaceWrites: 4 })
    const order: string[] = []
    const a = parkedWrite(s, order, 'a', A)
    const read = parkedWrite(s, order, 'read', A, 'read')
    const g = parkedWrite(s, order, 'global', GLOBAL_CONTEXT)
    await settle()
    expect(order).toEqual(['a:start', 'read:start'])
    read.release()
    await read.done
    await settle()
    expect(order.slice(-1)).toEqual(['global:start'])
    a.release()
    g.release()
    await Promise.all([a.done, g.done])
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses a declared bound of %s', (workspaceWrites) => {
    expect(() =>
      createScheduler({ driver: laneDriver({ readConcurrency: 1, workspaceWrites }) }),
    ).toThrow(/workspace write slots/)
  })
})

describe('one write slot on a driver that declares no per-workspace writes', () => {
  it('serialises writes of different workspaces and global work in call order', async () => {
    // Catches: the context reaching admission on SQLite, where one connection holds
    // every write and a second BEGIN IMMEDIATE would wait on the busy handler.
    const s = scheduler({ readConcurrency: 3 })
    const order: string[] = []
    const a = parkedWrite(s, order, 'a', A)
    const b = parkedWrite(s, order, 'b', B)
    const g = parkedWrite(s, order, 'global', GLOBAL_CONTEXT)
    const root = runRootStatementIn(C, () => parkedWrite(s, order, 'c-root', undefined))
    await settle()
    expect(order).toEqual(['a:start'])
    for (const parked of [root, g, b, a]) parked.release()
    await Promise.all([a.done, b.done, g.done, root.done])
    expect(order).toEqual([
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'global:start',
      'global:end',
      'c-root:start',
      'c-root:end',
    ])
  })

  it('runs one transaction at a time on bun:sqlite, whatever workspace each names', async () => {
    // The real driver behind the executor: two workspaces' transactions never have
    // two BEGINs open at once.
    const h = await openHarness()
    try {
      const order: string[] = []
      const gate = barrier()
      const first = h.executor.transact(async () => {
        order.push('a:start')
        await gate.wait()
        order.push('a:end')
      }, A)
      const second = h.executor.transact(async () => {
        order.push('b:start')
      }, B)
      await gate.reached()
      await settle()
      expect(order).toEqual(['a:start'])
      gate.release()
      await Promise.all([first, second])
      expect(order).toEqual(['a:start', 'a:end', 'b:start'])
      const begins = h.log.boundaries().filter((entry) => entry.endsWith('BEGIN IMMEDIATE'))
      expect(begins).toHaveLength(2)
    } finally {
      await h.close()
    }
  })
})

/**
 * The same properties on the real Postgres driver, in ONE process: one store, so
 * the scheduler, not a second pool, is what lets the workspaces overlap.
 */
describe.runIf(testStoreEngine() === 'pg')('per-workspace write slots on Postgres', () => {
  let url: string
  let admin: PgTestClient
  const opened: RootStoreExecutor<QueryClient>[] = []

  beforeAll(async () => {
    url = (await clonePgTestDatabase('file')).url
    admin = connectPgTest(url, 1)
    for (const statement of [
      'CREATE TABLE sync_feed (workspace_id text COLLATE "C" PRIMARY KEY, head_seq bigint NOT NULL DEFAULT 0)',
      "INSERT INTO sync_feed (workspace_id) VALUES ('ws_a'), ('ws_b')",
      'CREATE TABLE notes (id text COLLATE "C" PRIMARY KEY, body text)',
    ]) {
      await admin.unsafe(statement)
    }
  })

  afterEach(async () => {
    for (const store of opened.splice(0).reverse()) await store.close()
    await admin.unsafe('DELETE FROM notes')
  })

  afterAll(async () => {
    await admin?.close({ timeout: 5 })
  })

  function openStore(): RootStoreExecutor<QueryClient> {
    const store = createStoreExecutor<QueryClient>({
      driver: createPgStoreDriver({ url, poolSize: 4, strictTimestamps: true }),
      startOpen: true,
    })
    opened.push(store)
    return store
  }

  const insert = 'INSERT INTO notes (id, body) VALUES ($1, $2)'

  it("runs two workspaces' write bodies at the same time in one store", async () => {
    // Catches: the Postgres driver not declaring its write slots, or the executor
    // not passing the transaction's context, either of which puts every workspace
    // back on one slot.
    const store = openStore()
    const held = barrier()
    const entered = barrier()
    const writing = store.transact(async (tx) => {
      await tx.drizzle.run(insert, 'a', 'a')
      entered.release()
      await held.wait()
    }, A)
    await entered.wait()
    await store.transact(async (tx) => {
      await tx.drizzle.run(insert, 'b', 'b')
    }, B)
    const committed = await admin.unsafe<{ id: string }>('SELECT id FROM notes ORDER BY id')
    expect(committed.map((row) => row.id)).toEqual(['b'])
    held.release()
    await writing
  })

  it('queues a second write of one workspace in the scheduler, not on the lock', async () => {
    // Catches: two writers of one workspace both admitted, the second waiting on the
    // row lock (and failing busy after lock_timeout) instead of in the FIFO.
    const store = openStore()
    const held = barrier()
    const entered = barrier()
    const order: string[] = []
    const first = store.transact(async (tx) => {
      order.push('a1:start')
      await tx.drizzle.run(insert, 'a1', 'a')
      entered.release()
      await held.wait()
      order.push('a1:end')
    }, A)
    await entered.wait()
    let saw: unknown
    const second = store.transact(async (tx) => {
      order.push('a2:start')
      saw = await tx.drizzle.all('SELECT id FROM notes ORDER BY id')
    }, A)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const waiting = await admin.unsafe<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    )
    expect(order).toEqual(['a1:start'])
    expect(waiting[0]?.waiting, 'no writer of this store waits on the row lock').toBe(0)
    held.release()
    await Promise.all([first, second])
    expect(order).toEqual(['a1:start', 'a1:end', 'a2:start'])
    expect(saw).toEqual([{ id: 'a1' }])
  })
})
