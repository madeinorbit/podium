/**
 * THE ROUND-TRIP MODEL IS WHAT CROSSES THE WIRE [POD-6992, POD-6958 design 2.11].
 *
 * The statement probe counts round trips from the session calls a lease makes, by the
 * Postgres driver's pipelining rules (`RoundTripObservation`, `statement-probe.ts`). Those
 * counts pin the full `SessionStore` operations, which run on SQLite until a store boots
 * on Postgres (POD-6994), so the model has to be right about the driver.
 *
 * On the store shard: the model's rules, read off a SQLite store's executor (the same calls a
 * Postgres store makes), and the latency injection.
 *
 * On the Postgres leg (`server-store-pg`): each shape of lease (a read body, a write in a
 * workspace and in the global context, an empty body, root statements, a batch, a failed
 * batch, a nested transaction, a slice repository's read and upsert) runs through the
 * real Postgres driver to a TCP proxy that counts round trips on the wire: a client write
 * after the server last spoke. Each shape runs once to warm the connection (postgres.js
 * spends one more round trip the first time a connection prepares a statement with
 * parameters), then again counted, and the wire must equal the model.
 */

import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { asSessionId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { PG_SLICE_TABLES } from '../../test-support/pg-slice-tables'
import { clonePgTestDatabase, testStoreEngine } from '../../test-support/pg-test-database'
import { countRoundTrips, describeTrip } from '../../test-support/round-trip-count'
import { provisionWorkspaceFeed } from '../database'
import { ReadWatermarksRepository } from '../read-watermarks'
import { createBunSqliteDriver } from './bun-driver'
import type { QueryClient } from './driver'
import { createStoreExecutor, type RootStoreExecutor, workspaceContext } from './executor'
import { createPgStoreDriver } from './pg-driver'
import { pgQueryLayer } from './pg-drizzle'
import {
  injectRoundTripLatency,
  instrumentDriver,
  probeRoundTrips,
  type RoundTripObservation,
  statementProbeHubFor,
} from './statement-probe'
import { legacyWorkspaceQueries } from './sync-drizzle'

const ENGINE = testStoreEngine()
const WORKSPACE = workspaceContext(SELF_HOSTED_WORKSPACE_ID)

/** One shape of lease, written once for both engines' raw SQL. */
interface Shape {
  readonly name: string
  /** Round trips the model must count. */
  readonly roundTrips: number
  run(store: ProbedStore): Promise<unknown>
}

interface ProbedStore {
  readonly executor: RootStoreExecutor<QueryClient>
  readonly target: { readonly db: object }
  /** `$1` on Postgres, `?` on SQLite. */
  readonly p: (n: number) => string
  readonly watermarks: ReadWatermarksRepository
}

const READER = asSessionId('sess_reader')
const SESSION = asSessionId('sess_alpha')
const AT = '2026-11-17T12:00:00.000Z'

const touchFeed = (s: ProbedStore) =>
  `UPDATE sync_feed SET head_seq = head_seq WHERE workspace_id = ${s.p(1)}`

const SHAPES: readonly Shape[] = [
  {
    name: 'a read body of two statements: BEGIN rides on the first, then COMMIT',
    roundTrips: 3,
    run: async (s) =>
      await s.executor.read(async () => {
        await s.executor.drizzle.all('SELECT 1 AS one')
        await s.executor.drizzle.all('SELECT 2 AS two')
      }, WORKSPACE),
  },
  {
    name: 'a read body that runs nothing sends nothing',
    roundTrips: 0,
    run: async (s) => await s.executor.read(async () => undefined, WORKSPACE),
  },
  {
    name: 'a write in a workspace: BEGIN with the lock, two statements, COMMIT',
    roundTrips: 4,
    run: async (s) =>
      await s.executor.transact(async () => {
        await s.executor.drizzle.run(touchFeed(s), SELF_HOSTED_WORKSPACE_ID)
        await s.executor.drizzle.all('SELECT 1 AS one')
      }, WORKSPACE),
  },
  {
    name: 'a global write: BEGIN rides on its statement, then COMMIT',
    roundTrips: 2,
    run: async (s) =>
      await s.executor.transact(async () => {
        await s.executor.drizzle.run(touchFeed(s), SELF_HOSTED_WORKSPACE_ID)
      }),
  },
  {
    name: 'a write in a workspace that runs nothing still took its lock',
    roundTrips: 2,
    run: async (s) => await s.executor.transact(async () => undefined, WORKSPACE),
  },
  {
    name: 'a root read and a root global write: one each',
    roundTrips: 2,
    run: async (s) => {
      await s.executor.drizzle.all('SELECT 1 AS one')
      await s.executor.drizzle.run(touchFeed(s), SELF_HOSTED_WORKSPACE_ID)
    },
  },
  {
    name: 'a root batch: one, its BEGIN and COMMIT pipelined',
    roundTrips: 1,
    run: async (s) =>
      await s.executor.drizzle.batch([
        { sql: touchFeed(s), params: [SELF_HOSTED_WORKSPACE_ID], method: 'run', intent: 'write' },
        { sql: 'SELECT 1 AS one', params: [], method: 'all', intent: 'read' },
      ]),
  },
  {
    name: 'a batch in a workspace write: one, with its savepoint',
    roundTrips: 3,
    run: async (s) =>
      await s.executor.transact(async () => {
        await s.executor.drizzle.batch([
          { sql: touchFeed(s), params: [SELF_HOSTED_WORKSPACE_ID], method: 'run', intent: 'write' },
          { sql: touchFeed(s), params: [SELF_HOSTED_WORKSPACE_ID], method: 'run', intent: 'write' },
        ])
      }, WORKSPACE),
  },
  {
    name: 'a failed batch in a write: one more to roll its savepoint back',
    roundTrips: 5,
    run: async (s) =>
      await s.executor.transact(async () => {
        await expect(
          s.executor.drizzle.batch([
            {
              sql: touchFeed(s),
              params: [SELF_HOSTED_WORKSPACE_ID],
              method: 'run',
              intent: 'write',
            },
            { sql: 'SELECT * FROM no_such_table', params: [], method: 'all', intent: 'read' },
          ]),
        ).rejects.toThrow()
        await s.executor.drizzle.all('SELECT 1 AS one')
      }, WORKSPACE),
  },
  {
    name: 'a nested transaction: SAVEPOINT and RELEASE are one each',
    roundTrips: 5,
    run: async (s) =>
      await s.executor.transact(async (tx) => {
        await tx.transact(async () => {
          await s.executor.drizzle.all('SELECT 1 AS one')
        }, WORKSPACE)
      }, WORKSPACE),
  },
  {
    name: "a slice repository's root read and root upsert in the workspace: one each",
    roundTrips: 2,
    run: async (s) => {
      await s.watermarks.getRecapWatermark(READER, SESSION)
      await s.watermarks.setRecapWatermark(READER, SESSION, 'evt_1', AT)
    },
  },
]

/** The model's count for `shape`, with its breakdown. */
async function modelled(store: ProbedStore, shape: Shape) {
  const counted = await countRoundTrips(store.target, async () => await shape.run(store))
  return { roundTrips: counted.roundTrips, byCall: [...counted.byCall] }
}

describe.runIf(ENGINE === 'sqlite')('the round-trip model on a SQLite store', () => {
  let store: ProbedStore
  let database: ReturnType<typeof openMigratedTestDatabase>
  beforeAll(async () => {
    database = openMigratedTestDatabase()
    const driver = createBunSqliteDriver({ database })
    const target = { db: database }
    const executor = createStoreExecutor<QueryClient>({
      driver: instrumentDriver(driver, statementProbeHubFor(database)),
      startOpen: true,
    })
    await executor.transact(async () => {
      await provisionWorkspaceFeed(executor.queries.db).run({
        workspaceId: SELF_HOSTED_WORKSPACE_ID,
        feedId: randomUUID(),
        epoch: randomUUID(),
        mintedAt: Date.now(),
      })
    })
    store = {
      executor,
      target,
      p: () => '?',
      watermarks: new ReadWatermarksRepository(
        legacyWorkspaceQueries(executor.queries, SELF_HOSTED_WORKSPACE_ID),
      ),
    }
  })
  afterAll(async () => {
    await store?.executor.close()
    database?.close()
  })

  it.each(SHAPES.map((shape) => [shape.name, shape] as const))('%s', async (_name, shape) => {
    const counted = await modelled(store, shape)
    expect(counted.roundTrips, counted.byCall.map(([k, n]) => `${n} ${k}`).join('\n')).toBe(
      shape.roundTrips,
    )
  })

  it('names each round trip by its call, lane and first statement', async () => {
    const seen: RoundTripObservation[] = []
    const detach = probeRoundTrips(store.target, (trip) => {
      seen.push(trip)
    })
    try {
      await SHAPES[2]?.run(store)
    } finally {
      detach()
    }
    expect(seen.map(describeTrip)).toEqual([
      'begin (write)',
      'statement (write): UPDATE sync_feed SET head_seq = head_seq WHERE workspace_id = ?',
      'statement (write): SELECT 1 AS one',
      'commit (write)',
    ])
  })

  it('injects the asked latency before each round trip', async () => {
    const detach = injectRoundTripLatency(store.target, 5)
    const startedAt = performance.now()
    try {
      await SHAPES[0]?.run(store)
    } finally {
      detach()
    }
    // Three round trips at 5 ms each; SQLite itself adds microseconds.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(15)
  })
})

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** A TCP proxy in front of Postgres that counts round trips as the wire carries them. */
interface WireCounter {
  readonly url: string
  /** Client writes after the server last spoke, on every connection, since {@link reset}. */
  roundTrips(): number
  reset(): void
  close(): Promise<void>
}

async function countingProxy(targetUrl: string): Promise<WireCounter> {
  const target = new URL(targetUrl)
  let trips = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((client) => {
    const upstream = createConnection({
      host: target.hostname,
      port: Number(target.port || 5432),
    })
    sockets.add(client)
    sockets.add(upstream)
    // A round trip starts when the client writes after the server last spoke.
    let serverSpoke = true
    client.on('data', (chunk) => {
      if (serverSpoke) trips += 1
      serverSpoke = false
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      serverSpoke = true
      client.write(chunk)
    })
    const end = () => {
      client.destroy()
      upstream.destroy()
      sockets.delete(client)
      sockets.delete(upstream)
    }
    client.on('close', end)
    upstream.on('close', end)
    client.on('error', end)
    upstream.on('error', end)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('proxy has no port')
  const url = new URL(targetUrl)
  url.hostname = '127.0.0.1'
  url.port = String(address.port)
  return {
    url: url.toString(),
    roundTrips: () => trips,
    reset: () => {
      trips = 0
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe.runIf(ENGINE === 'pg')('the round-trip model against the wire (Postgres leg)', () => {
  let store: ProbedStore
  let wire: WireCounter
  beforeAll(async () => {
    const { url } = await clonePgTestDatabase('file')
    wire = await countingProxy(url)
    const target = { db: {} }
    // One pooled connection, so every shape's second run finds its statements prepared.
    const executor = createStoreExecutor<QueryClient>({
      driver: instrumentDriver(
        createPgStoreDriver({ url: wire.url, poolSize: 1 }),
        statementProbeHubFor(target.db),
      ),
      queryLayer: pgQueryLayer(PG_SLICE_TABLES),
      startOpen: true,
    })
    await executor.transact(async () => {
      await provisionWorkspaceFeed(executor.queries.db).run({
        workspaceId: SELF_HOSTED_WORKSPACE_ID,
        feedId: randomUUID(),
        epoch: randomUUID(),
        mintedAt: Date.now(),
      })
    })
    store = {
      executor,
      target,
      p: (n) => `$${n}`,
      watermarks: new ReadWatermarksRepository(
        legacyWorkspaceQueries(executor.queries, SELF_HOSTED_WORKSPACE_ID),
      ),
    }
  }, 60_000)
  afterAll(async () => {
    await store?.executor.close()
    await wire?.close()
  })

  it.each(SHAPES.map((shape) => [shape.name, shape] as const))('%s', async (_name, shape) => {
    await shape.run(store)
    wire.reset()
    const counted = await modelled(store, shape)
    const onWire = wire.roundTrips()
    const detail = counted.byCall.map(([k, n]) => `${n} ${k}`).join('\n')
    expect(counted.roundTrips, detail).toBe(shape.roundTrips)
    expect(onWire, `the wire carried ${onWire} round trips, the model counted:\n${detail}`).toBe(
      counted.roundTrips,
    )
  })

  it('counts the cold Describe a first preparation costs, which the model leaves out', async () => {
    // A statement text this connection has never prepared, with a parameter.
    const text = `SELECT head_seq FROM sync_feed WHERE workspace_id = $1 AND ${Date.now()} > 0`
    wire.reset()
    await store.executor.drizzle.all(text, SELF_HOSTED_WORKSPACE_ID)
    expect(wire.roundTrips()).toBe(2)
    wire.reset()
    await store.executor.drizzle.all(text, SELF_HOSTED_WORKSPACE_ID)
    expect(wire.roundTrips()).toBe(1)
  })
})
