/**
 * ATTRIBUTION PARITY, AND THE THING THAT MADE IT NECESSARY [POD-3281].
 *
 * Two claims are under test and they are different claims.
 *
 * PARITY. The numbers the driver seam records must be the numbers the old
 * `SqlDatabase` wrapper recorded, for every statement shape including a
 * throwing one — otherwise "no increase against the recorded baseline" would be
 * comparing two instruments rather than two versions of the code.
 *
 * THE DEFEAT. The reason the seam had to move at all is the driver's
 * prepared-statement cache: a probe hooked to `prepare` sees ONE preparation and
 * then nothing, however many times the statement runs. That is asserted here
 * directly, against the real bun driver, because it is the mechanism the whole
 * issue turns on and it is invisible from a passing count (spec §6 rule 14).
 */

import {
  attributeQueries,
  openDatabase,
  queryAttributionSnapshot,
  resetQueryAttribution,
  type SqlDatabase,
} from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBunSqliteDriver } from './bun-driver'
import type { DriverSession, Statement, StoreDriver } from './driver'
import { NO_BUSY_RETRY, UNBOUNDED_WRITE_BUDGET_MS } from './driver'
import { observeLegacyHandle } from './legacy-handle-probe'
import {
  instrumentDriver,
  queryAttributionProbe,
  type StatementObservation,
  StatementProbeHub,
} from './statement-probe'

let db: SqlDatabase
let open: SqlDatabase[]

const schema = (handle: SqlDatabase): void => {
  handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL UNIQUE)')
  handle.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run()
  handle.prepare("INSERT INTO t (id, v) VALUES (2, 'b')").run()
}

const fresh = (): SqlDatabase => {
  const handle = openDatabase(':memory:')
  schema(handle)
  open.push(handle)
  return handle
}

beforeEach(() => {
  open = []
  db = fresh()
  resetQueryAttribution()
})

afterEach(() => {
  for (const handle of open) {
    try {
      handle.close()
    } catch {
      // Already closed by the driver under test; closing twice is not the point.
    }
  }
})

/** Run `statement` through the driver seam with the profiler probe attached. */
const throughDriver = async (handle: SqlDatabase, statement: Statement): Promise<void> => {
  const hub = new StatementProbeHub()
  hub.attach(queryAttributionProbe)
  const driver = instrumentDriver(createBunSqliteDriver({ database: handle }), hub)
  const session = await driver.open(statement.intent === 'write' ? 'write' : 'read')
  try {
    await session.execute(statement)
  } finally {
    await session.close()
  }
}

/** The same statement through the old wrapper, executed the same number of times. */
const throughWrapper = (handle: SqlDatabase, statement: Statement): void => {
  const st = attributeQueries(handle, true).prepare(statement.sql)
  const params = [...statement.params]
  if (statement.method === 'run') st.run(...params)
  else if (statement.method === 'get') st.get(...params)
  else st.all(...params)
}

const costOf = (sql: string): { count: number; rows: number } => {
  const cost = queryAttributionSnapshot().get(sql)
  return { count: cost?.count ?? 0, rows: cost?.rows ?? 0 }
}

const SHAPES: { name: string; statement: Statement }[] = [
  {
    name: 'get',
    statement: { sql: 'SELECT v FROM t WHERE id = ?', params: [1], method: 'get', intent: 'read' },
  },
  {
    name: 'get with no row',
    statement: { sql: 'SELECT v FROM t WHERE id = ?', params: [99], method: 'get', intent: 'read' },
  },
  {
    name: 'all',
    statement: { sql: 'SELECT v FROM t ORDER BY id', params: [], method: 'all', intent: 'read' },
  },
  {
    name: 'write',
    statement: {
      sql: 'INSERT INTO t (id, v) VALUES (?, ?)',
      params: [3, 'c'],
      method: 'run',
      intent: 'write',
    },
  },
]

describe('parity between the SqlDatabase wrapper and the driver seam', () => {
  for (const { name, statement } of SHAPES) {
    it(`records the same count and rows for a ${name}`, async () => {
      resetQueryAttribution()
      throughWrapper(fresh(), statement)
      const wrapper = costOf(statement.sql)

      resetQueryAttribution()
      await throughDriver(fresh(), statement)
      const seam = costOf(statement.sql)

      // Non-vacuous: the shape must have been recorded at all, or two zeroes
      // would agree perfectly and prove nothing.
      expect(wrapper.count).toBe(1)
      expect(seam).toEqual(wrapper)
    })
  }

  it('records a thrown statement with its time and zero rows, on both seams', async () => {
    const failing: Statement = {
      sql: 'INSERT INTO t (id, v) VALUES (?, ?)',
      params: [9, 'a'],
      method: 'run',
      intent: 'write',
    }

    resetQueryAttribution()
    expect(() => throughWrapper(fresh(), failing)).toThrow()
    const wrapper = costOf(failing.sql)

    resetQueryAttribution()
    await expect(throughDriver(fresh(), failing)).rejects.toThrow()
    const seam = costOf(failing.sql)

    expect(wrapper).toEqual({ count: 1, rows: 0 })
    expect(seam).toEqual(wrapper)
  })

  it('records the raw-handle feed identically, so a half-converted store reads as one number', () => {
    const statement = SHAPES[2]?.statement
    if (!statement) throw new Error('shape fixture is empty')

    resetQueryAttribution()
    throughWrapper(fresh(), statement)
    const wrapper = costOf(statement.sql)

    resetQueryAttribution()
    const handle = fresh()
    const hub = new StatementProbeHub()
    hub.attach(queryAttributionProbe)
    observeLegacyHandle({ db: handle }, hub)
    handle.prepare(statement.sql).all()

    expect(costOf(statement.sql)).toEqual(wrapper)
  })
})

describe('the statement cache the seam had to move past', () => {
  it('counts every execution although the driver prepares the text once', async () => {
    const prepared: string[] = []
    const spy: SqlDatabase = {
      prepare: (sql) => {
        prepared.push(sql)
        return db.prepare(sql)
      },
      exec: (sql) => db.exec(sql),
      close: () => {},
    }
    const seen: StatementObservation[] = []
    const hub = new StatementProbeHub()
    hub.attach((observation) => seen.push(observation))
    const driver = instrumentDriver(createBunSqliteDriver({ database: spy }), hub)
    const session = await driver.open('read')
    const statement: Statement = {
      sql: 'SELECT v FROM t WHERE id = ?',
      params: [1],
      method: 'get',
      intent: 'read',
    }
    for (let i = 0; i < 3; i += 1) await session.execute(statement)
    await session.close()

    // THE DEFEAT, stated as two numbers that must differ. A prepare-hooked
    // probe would report 1 here and call the other two reads free.
    expect(prepared).toEqual(['SELECT v FROM t WHERE id = ?'])
    expect(seen).toHaveLength(3)
    expect(seen.every((o) => o.rows === 1 && !o.failed)).toBe(true)
  })
})

describe('what the driver seam observes', () => {
  it('reports each member of a batch, with the round trip it rode in', async () => {
    const seen: StatementObservation[] = []
    const hub = new StatementProbeHub()
    hub.attach((observation) => seen.push(observation))
    const driver = instrumentDriver(createBunSqliteDriver({ database: db }), hub)
    const session = await driver.open('write')
    await session.executeBatch([
      {
        sql: 'INSERT INTO t (id, v) VALUES (?, ?)',
        params: [4, 'd'],
        method: 'run',
        intent: 'write',
      },
      { sql: 'SELECT v FROM t ORDER BY id', params: [], method: 'all', intent: 'read' },
    ])
    await session.close()

    expect(seen.map((o) => [o.batchIndex, o.batchSize, o.rows])).toEqual([
      [0, 2, 0],
      [1, 2, 3],
    ])
    // One round trip, one duration: the members share it rather than each
    // inventing a share of a call that was never split.
    expect(seen[0]?.durationMs).toBe(seen[1]?.durationMs)
  })

  it('reports every member of a batch that failed part-way, because the call was still made', async () => {
    const seen: StatementObservation[] = []
    const hub = new StatementProbeHub()
    hub.attach((observation) => seen.push(observation))
    const driver = instrumentDriver(createBunSqliteDriver({ database: db }), hub)
    const session = await driver.open('write')
    await expect(
      session.executeBatch([
        {
          sql: 'INSERT INTO t (id, v) VALUES (?, ?)',
          params: [5, 'e'],
          method: 'run',
          intent: 'write',
        },
        {
          sql: 'INSERT INTO t (id, v) VALUES (?, ?)',
          params: [6, 'a'],
          method: 'run',
          intent: 'write',
        },
      ]),
    ).rejects.toThrow()
    await session.close()

    expect(seen).toHaveLength(2)
    expect(seen.every((o) => o.failed && o.rows === 0)).toBe(true)
  })

  it('carries the DECLARED intent through, never one read off the method', async () => {
    const seen: StatementObservation[] = []
    const hub = new StatementProbeHub()
    hub.attach((observation) => seen.push(observation))
    const driver = instrumentDriver(createBunSqliteDriver({ database: db }), hub)
    const session = await driver.open('write')
    // `INSERT ... RETURNING` — decodes as `get`, and is a write. The pair that
    // POD-3318 exists for has to survive the instrument too.
    await session.execute({
      sql: 'INSERT INTO t (id, v) VALUES (?, ?) RETURNING id',
      params: [7, 'g'],
      method: 'get',
      intent: 'write',
    })
    await session.close()

    expect(seen[0]?.method).toBe('get')
    expect(seen[0]?.intent).toBe('write')
  })

  it('does not observe the transaction boundaries, which are the driver’s own', async () => {
    const seen: StatementObservation[] = []
    const hub = new StatementProbeHub()
    hub.attach((observation) => seen.push(observation))
    const driver = instrumentDriver(createBunSqliteDriver({ database: db }), hub)
    const session = await driver.open('write')
    await session.begin('write')
    await session.enterSavepoint('sp1')
    await session.releaseSavepoint('sp1')
    await session.commit()
    await session.close()

    expect(seen).toEqual([])
  })

  it('keeps `openReader` ABSENT when the driver has none, because it is a capability', async () => {
    const hub = new StatementProbeHub()
    const without = instrumentDriver(createBunSqliteDriver({ database: db }), hub)
    expect(without.openReader).toBeUndefined()

    const reader = fresh()
    const with_ = instrumentDriver(
      createBunSqliteDriver({ database: fresh(), openReader: () => reader }),
      hub,
    )
    expect(typeof with_.openReader).toBe('function')
  })

  it('forwards `classify`, `limits` and `lanes` from the driver it wraps', () => {
    const inner: StoreDriver<unknown> = {
      kind: 'fake',
      lanes: { readConcurrency: 4 },
      limits: { writeBudgetMs: 9_000, busyRetry: NO_BUSY_RETRY },
      classify: () => 'busy',
      open: async () => ({}) as DriverSession,
      client: () => ({}),
      close: async () => {},
    }
    const wrapped = instrumentDriver(inner, new StatementProbeHub())
    expect(wrapped.kind).toBe('fake')
    expect(wrapped.lanes.readConcurrency).toBe(4)
    expect(wrapped.limits.writeBudgetMs).toBe(9_000)
    expect(wrapped.classify?.(new Error('busy'))).toBe('busy')
    expect(UNBOUNDED_WRITE_BUDGET_MS).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('the hub', () => {
  it('does not let a throwing probe take the statement down with it', async () => {
    const reported: unknown[] = []
    const hub = new StatementProbeHub((error) => reported.push(error))
    const seen: string[] = []
    hub.attach(() => {
      throw new Error('probe exploded')
    })
    hub.attach((observation) => seen.push(observation.sql))
    const driver = instrumentDriver(createBunSqliteDriver({ database: db }), hub)
    const session = await driver.open('read')
    const rows = await session.execute({
      sql: 'SELECT v FROM t ORDER BY id',
      params: [],
      method: 'all',
      intent: 'read',
    })
    await session.close()

    expect(rows.rows).toHaveLength(2)
    // The second probe still ran: a throwing probe is isolated, not a barrier.
    expect(seen).toEqual(['SELECT v FROM t ORDER BY id'])
    // And it was REPORTED. A silently swallowed probe error is a probe that
    // stopped counting and nobody found out.
    expect(reported).toHaveLength(1)
  })

  it('stops observing once every probe has detached', async () => {
    const hub = new StatementProbeHub()
    const seen: string[] = []
    const detach = hub.attach((observation) => seen.push(observation.sql))
    expect(hub.active).toBe(true)
    detach()
    detach()
    expect(hub.active).toBe(false)

    const driver = instrumentDriver(createBunSqliteDriver({ database: db }), hub)
    const session = await driver.open('read')
    await session.execute({ sql: 'SELECT 1', params: [], method: 'all', intent: 'read' })
    await session.close()
    expect(seen).toEqual([])
  })
})

describe('the legacy handle feed', () => {
  it('restores the original prepare on detach, so a second window is not double counted', () => {
    const handle = fresh()
    const before = handle.prepare
    const seen: StatementObservation[] = []
    const hub = new StatementProbeHub()
    hub.attach((observation) => seen.push(observation))
    const restore = observeLegacyHandle({ db: handle }, hub)
    handle.prepare('SELECT v FROM t').all()
    restore()
    handle.prepare('SELECT v FROM t').all()

    expect(seen).toHaveLength(1)
    expect(handle.prepare).toBe(before)
  })

  it('declares no intent, because a raw-handle caller declared none', () => {
    const handle = fresh()
    const seen: StatementObservation[] = []
    const hub = new StatementProbeHub()
    hub.attach((observation) => seen.push(observation))
    observeLegacyHandle({ db: handle }, hub)
    handle.prepare("INSERT INTO t (id, v) VALUES (8, 'h')").run()

    expect(seen[0]?.intent).toBe('undeclared')
    expect(seen[0]?.seam).toBe('legacy-handle')
    expect(seen[0]?.method).toBe('run')
  })
})
