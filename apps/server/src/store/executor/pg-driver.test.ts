/**
 * The Postgres store driver [POD-6979, POD-6958 design 2.4].
 *
 * Runs on the `server-store-pg` lane against a fresh database cloned from the run's
 * template. Each test makes the tables it needs; the workspace lock reads `sync_feed`.
 *
 * Round trips are counted ON THE WIRE, by a TCP proxy between the pool and the server:
 * a round trip is the client sending after the server last spoke. A count the driver
 * kept itself would only restate its own design.
 */

import { createServer, type Server, type Socket, connect as tcpConnect } from 'node:net'
import { asWorkspaceId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { sql } from 'drizzle-orm'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  openPgStoreDriver,
  openStoreDatabase,
  PostgresLocationError,
  storeEngineFor,
} from '../../store-database'
import {
  clonePgTestDatabase,
  connectPgTest,
  type PgTestClient,
  testStoreEngine,
} from '../../test-support/pg-test-database'
import { createBunStoreExecutor } from './bun-driver'
import type { DriverSession, QueryClient, StoreDriver } from './driver'
import { createStoreExecutor, type RootStoreExecutor, workspaceContext } from './executor'
import { barrier, settle } from './harness'
import {
  createPgStoreDriver,
  createPgStoreExecutor,
  type PgDriverOptions,
  PgPoolTimeoutError,
  PgTransactionAbortedError,
  WorkspaceFeedRowMissingError,
} from './pg-driver'
import { buildPgStoreDrizzle, type StorePgPreparedQuery } from './pg-drizzle'
import { prepared, preparedGlobal, workspaceQueries } from './sync-drizzle'

const liteNotes = sqliteTable('notes', { id: text('id').primaryKey(), body: text('body') })
const pgNotes = pgTable('notes', { id: pgText('id').primaryKey(), body: pgText('body') })
type NoteTables = { readonly notes: typeof liteNotes }

/** A workspace definition and a global one over the test's notes table. */
const insertWorkspaceNote = prepared((db, t) =>
  db
    .insert((t as unknown as NoteTables).notes)
    .values({ id: sql.placeholder('id'), body: sql.placeholder('body') })
    .prepare(),
)
const insertGlobalNote = preparedGlobal((db, t) =>
  db
    .insert((t as unknown as NoteTables).notes)
    .values({ id: sql.placeholder('id'), body: sql.placeholder('body') })
    .prepare(),
)

const WS_A = workspaceContext(asWorkspaceId('ws_a'))
const WS_B = workspaceContext(asWorkspaceId('ws_b'))
const WS_MISSING = workspaceContext(asWorkspaceId('ws_missing'))

const SCHEMA = [
  'CREATE TABLE sync_feed (workspace_id text COLLATE "C" PRIMARY KEY, head_seq bigint NOT NULL DEFAULT 0)',
  "INSERT INTO sync_feed (workspace_id) VALUES ('ws_a'), ('ws_b')",
  'CREATE TABLE notes (id text COLLATE "C" PRIMARY KEY, body text)',
]

interface WireProxy {
  readonly url: string
  /** Round trips so far: the client sent after the server had last spoken. */
  roundTrips(): number
  close(): Promise<void>
}

/** A TCP proxy to the database at `target` that counts round trips per connection. */
async function wireProxy(target: string): Promise<WireProxy> {
  const upstreamUrl = new URL(target)
  let roundTrips = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((client) => {
    let spoke: 'client' | 'server' | undefined
    const upstream = tcpConnect(Number(upstreamUrl.port), upstreamUrl.hostname)
    sockets.add(client)
    sockets.add(upstream)
    client.on('data', (chunk) => {
      if (spoke !== 'client') roundTrips += 1
      spoke = 'client'
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      spoke = 'server'
      client.write(chunk)
    })
    const end = (): void => {
      client.destroy()
      upstream.destroy()
    }
    client.on('close', end)
    upstream.on('close', end)
    client.on('error', end)
    upstream.on('error', end)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('proxy has no port')
  const url = new URL(target)
  url.hostname = '127.0.0.1'
  url.port = String(address.port)
  return {
    url: url.toString(),
    roundTrips: () => roundTrips,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

/** Wait until `condition` holds or `ms` pass; true when it held. */
async function eventually(condition: () => boolean, ms = 2_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return condition()
}

describe('Postgres store driver, without a database', () => {
  // Nothing connects: a postgres.js pool opens connections on first use.
  const nowhere = 'postgres://podium@127.0.0.1:9/nowhere'

  it('reads beside one writer: readConcurrency is the pool size minus one unless lowered', async () => {
    const drivers = [
      createPgStoreDriver({ url: nowhere, poolSize: 4 }),
      createPgStoreDriver({ url: nowhere, poolSize: 4, readConcurrency: 0 }),
      createPgStoreDriver({ url: nowhere, poolSize: 4, readConcurrency: 9 }),
      createPgStoreDriver({ url: nowhere, poolSize: 1 }),
    ]
    expect(drivers.map((driver) => driver.lanes.readConcurrency)).toEqual([3, 0, 3, 0])
    expect(drivers.every((driver) => driver.dialect === 'pg' && driver.openReader)).toBe(true)
    for (const driver of drivers) await driver.close()
  })

  it('classifies as busy only what it marked busy while acquiring', async () => {
    const driver = createPgStoreDriver({ url: nowhere })
    expect(driver.classify(new PgPoolTimeoutError(5))).toBe('fatal')
    expect(driver.classify(Object.assign(new Error('lock'), { code: '55P03' }))).toBe('fatal')
    expect(driver.classify('not an error')).toBe('fatal')
    await driver.close()
  })

  it('chooses the engine from the store location', async () => {
    expect(storeEngineFor('postgres://u@h/db')).toBe('pg')
    expect(storeEngineFor('postgresql://u@h:6432/db?sslmode=require')).toBe('pg')
    expect(storeEngineFor('POSTGRES://u@h/db')).toBe('pg')
    expect(storeEngineFor(':memory:')).toBe('sqlite')
    expect(storeEngineFor('/var/lib/podium/podium.db')).toBe('sqlite')
    expect(storeEngineFor('postgres.db')).toBe('sqlite')
    await expect(openStoreDatabase('postgres://u@h/db')).rejects.toBeInstanceOf(
      PostgresLocationError,
    )
    await expect(openPgStoreDriver('/tmp/podium.db')).rejects.toThrow(/postgres:\/\/ URL/)
    const driver = await openPgStoreDriver(nowhere)
    expect(driver.dialect).toBe('pg')
    await driver.close()
  })
})

describe.runIf(testStoreEngine() === 'pg')('Postgres store driver', () => {
  let url: string
  let admin: PgTestClient
  const opened: { close(): Promise<void> }[] = []

  beforeAll(async () => {
    url = (await clonePgTestDatabase('file')).url
    admin = connectPgTest(url, 1)
    for (const statement of SCHEMA) await admin.unsafe(statement)
  })

  afterEach(async () => {
    for (const store of opened.splice(0).reverse()) await store.close()
    await admin.unsafe('DELETE FROM notes')
  })

  afterAll(async () => {
    await admin?.close({ timeout: 5 })
  })

  function openStore(
    options: Partial<PgDriverOptions> = {},
    wrap: (driver: StoreDriver<QueryClient>) => StoreDriver<QueryClient> = (driver) => driver,
  ): RootStoreExecutor<QueryClient> {
    const executor = createStoreExecutor<QueryClient>({
      driver: wrap(createPgStoreDriver({ url, strictTimestamps: true, ...options })),
      startOpen: true,
    })
    opened.push(executor)
    return executor
  }

  async function bodies(): Promise<string[]> {
    const rows = await admin.unsafe<{ id: string }>('SELECT id FROM notes ORDER BY id')
    return rows.map((row) => row.id)
  }

  describe('round trips', () => {
    let proxy: WireProxy
    beforeAll(async () => {
      proxy = await wireProxy(url)
    })
    afterAll(async () => {
      await proxy?.close()
    })

    /** Round trips `work` costs, on a warm single-connection pool behind the proxy. */
    async function measure(work: () => Promise<void>) {
      const before = proxy.roundTrips()
      await work()
      return proxy.roundTrips() - before
    }

    it('costs one round trip before a workspace write body runs, and one per statement after', async () => {
      const store = openStore({ url: proxy.url, poolSize: 1 })
      const insert = 'INSERT INTO notes (id, body) VALUES ($1, $2)'
      // Warm: the connection, and each statement prepared once on it.
      await store.transact(async (tx) => {
        await tx.drizzle.run(insert, 'warm', 'w')
      }, WS_A)
      const marks: number[] = []
      const before = proxy.roundTrips()
      await store.transact(async (tx) => {
        marks.push(proxy.roundTrips() - before)
        await tx.drizzle.run(insert, 'first', 'f')
        marks.push(proxy.roundTrips() - before)
        await tx.drizzle.run(insert, 'second', 's')
        marks.push(proxy.roundTrips() - before)
      }, WS_A)
      const total = proxy.roundTrips() - before
      // BEGIN + SET LOCAL lock_timeout + the lock, as one round trip.
      expect(marks).toEqual([1, 2, 3])
      // ...and the COMMIT.
      expect(total).toBe(4)
      expect(await bodies()).toEqual(['first', 'second', 'warm'])
    })

    it('pipelines a read body BEGIN with its first statement', async () => {
      const store = openStore({ url: proxy.url, poolSize: 1 })
      const select = 'SELECT count(*) AS n FROM notes WHERE body = $1'
      await store.read(async (tx) => {
        await tx.drizzle.get(select, 'x')
      })
      const marks: number[] = []
      const before = proxy.roundTrips()
      await store.read(async (tx) => {
        marks.push(proxy.roundTrips() - before)
        expect(await tx.drizzle.get(select, 'x')).toEqual({ n: 0 })
        marks.push(proxy.roundTrips() - before)
      })
      expect(marks).toEqual([0, 1])
      expect(proxy.roundTrips() - before).toBe(2)
    })

    it('pipelines a global write BEGIN with its first statement', async () => {
      const store = openStore({ url: proxy.url, poolSize: 1 })
      const insert = 'INSERT INTO notes (id, body) VALUES ($1, $2)'
      await store.transact(async (tx) => {
        await tx.drizzle.run(insert, 'warm', 'w')
      })
      const cost = await measure(async () => {
        await store.transact(async (tx) => {
          await tx.drizzle.run(insert, 'global', 'g')
        })
      })
      expect(cost).toBe(2)
    })

    it('runs a root batch as one round trip, and a batch inside a transaction as one', async () => {
      const store = openStore({ url: proxy.url, poolSize: 1 })
      const insert = 'INSERT INTO notes (id, body) VALUES ($1, $2)'
      const batch = (ids: string[]) =>
        ids.map((id) => ({
          sql: insert,
          params: [id, id],
          method: 'run' as const,
          intent: 'write' as const,
        }))
      await store.drizzle.batch(batch(['w1', 'w2']))
      expect(await measure(async () => void (await store.drizzle.batch(batch(['r1', 'r2']))))).toBe(
        1,
      )
      const inside: number[] = []
      await store.transact(async (tx) => {
        await tx.drizzle.run(insert, 't0', 't0')
        const before = proxy.roundTrips()
        await tx.drizzle.batch(batch(['t1', 't2']))
        inside.push(proxy.roundTrips() - before)
      }, WS_A)
      expect(inside).toEqual([1])
    })

    it('prepares a repeated statement once per connection', async () => {
      const store = openStore({ url: proxy.url, poolSize: 1 })
      const select = 'SELECT body FROM notes WHERE id = $1'
      for (let i = 0; i < 3; i++) await store.drizzle.get(select, `n${i}`)
      await store.transact(async (tx) => {
        await tx.drizzle.get(select, 'inside')
      }, WS_A)
      const prepared = (await store.drizzle.all(
        'SELECT statement FROM pg_prepared_statements WHERE statement = $1',
        select,
      )) as { statement: string }[]
      expect(prepared).toHaveLength(1)
    })
  })

  describe('root writes through query handles', () => {
    function openQueries() {
      const store = createPgStoreExecutor({ url, startOpen: true, pgTables: { notes: pgNotes } })
      opened.push(store)
      return { store, queries: store.queries }
    }

    it('builds the store queries on Postgres', () => {
      const { queries } = openQueries()
      const statement = insertGlobalNote(queries.db) as unknown as StorePgPreparedQuery
      expect(statement.getQuery().sql).toBe('insert into "notes" ("id", "body") values ($1, $2)')
    })

    it("takes the workspace's lock for a root write through its handle, and none through the global handle", async () => {
      const { queries } = openQueries()
      const holder = openStore()
      const held = barrier()
      const entered = barrier()
      const holding = holder.transact(async () => {
        entered.release()
        await held.wait()
      }, WS_A)
      await entered.wait()

      // Global handle: no workspace, no lock, so it does not wait for ws_a's holder.
      await insertGlobalNote(queries.db).run({ id: 'global', body: 'g' })
      // Another workspace's handle waits only for its own lock.
      await insertWorkspaceNote(workspaceQueries(queries, asWorkspaceId('ws_b')).db).run({
        id: 'ws_b',
        body: 'b',
      })
      expect(await bodies()).toEqual(['global', 'ws_b'])

      // ws_a's handle waits for the holder: its root write took ws_a's lock.
      let landed = false
      const waiting = insertWorkspaceNote(workspaceQueries(queries, asWorkspaceId('ws_a')).db)
        .run({ id: 'ws_a', body: 'a' })
        .then(() => {
          landed = true
        })
      expect(await eventually(() => landed, 300)).toBe(false)
      held.release()
      await Promise.all([holding, waiting])
      expect(await bodies()).toEqual(['global', 'ws_a', 'ws_b'])
    })

    it('refuses a root write through a workspace handle that has no feed row', async () => {
      const { queries } = openQueries()
      await expect(
        insertWorkspaceNote(workspaceQueries(queries, asWorkspaceId('ws_missing')).db).run({
          id: 'missing',
          body: 'm',
        }),
      ).rejects.toBeInstanceOf(WorkspaceFeedRowMissingError)
      expect(await bodies()).toEqual([])
    })
  })

  describe('one writer per workspace', () => {
    it('serialises two write transactions in one workspace across two stores', async () => {
      const first = openStore()
      const second = openStore()
      const held = barrier()
      const entered = barrier()
      const writing = first.transact(async (tx) => {
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'first', 'f')
        entered.release()
        await held.wait()
      }, WS_A)
      await entered.wait()
      let started = false
      let saw: unknown
      const waiting = second.transact(async (tx) => {
        started = true
        saw = await tx.drizzle.all('SELECT id FROM notes')
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'second', 's')
      }, WS_A)
      expect(await eventually(() => started, 300)).toBe(false)
      held.release()
      await Promise.all([writing, waiting])
      expect(started).toBe(true)
      // The second writer's lock was granted after the first committed, so it saw it.
      expect(saw).toEqual([{ id: 'first' }])
      expect(await bodies()).toEqual(['first', 'second'])
    })

    it('runs write transactions of two workspaces in parallel', async () => {
      const first = openStore()
      const second = openStore()
      const held = barrier()
      const entered = barrier()
      const writing = first.transact(async (tx) => {
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'a', 'a')
        entered.release()
        await held.wait()
      }, WS_A)
      await entered.wait()
      await second.transact(async (tx) => {
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'b', 'b')
      }, WS_B)
      expect(await bodies()).toEqual(['b'])
      held.release()
      await writing
      expect(await bodies()).toEqual(['a', 'b'])
    })

    it('refuses a write in a workspace with no feed row, without retrying', async () => {
      const classified: string[] = []
      const store = openStore({}, (driver) => ({
        ...driver,
        classify: (error) => {
          const verdict = driver.classify?.(error) ?? 'fatal'
          classified.push(verdict)
          return verdict
        },
      }))
      let ran = false
      await expect(
        store.transact(async () => {
          ran = true
        }, WS_MISSING),
      ).rejects.toBeInstanceOf(WorkspaceFeedRowMissingError)
      expect(ran).toBe(false)
      expect(classified).toEqual(['fatal'])
    })
  })

  describe('busy is retried only at begin', () => {
    it('retries a lock timeout on the workspace lock, then gives up', async () => {
      const holder = openStore()
      const classified: string[] = []
      const contender = openStore(
        { lockTimeoutMs: 30, busyRetry: { attempts: 3, initialDelayMs: 5, maxDelayMs: 5 } },
        (driver) => ({
          ...driver,
          classify: (error) => {
            const verdict = driver.classify?.(error) ?? 'fatal'
            classified.push(verdict)
            return verdict
          },
        }),
      )
      const held = barrier()
      const entered = barrier()
      const holding = holder.transact(async () => {
        entered.release()
        await held.wait()
      }, WS_A)
      await entered.wait()
      let bodyRuns = 0
      await expect(
        contender.transact(async () => {
          bodyRuns += 1
        }, WS_A),
      ).rejects.toMatchObject({ code: '55P03' })
      expect(bodyRuns).toBe(0)
      expect(classified).toEqual(['busy', 'busy', 'busy'])
      held.release()
      await holding
      // The workspace is free again: the next attempt gets the lock.
      await contender.transact(async () => {
        bodyRuns += 1
      }, WS_A)
      expect(bodyRuns).toBe(1)
    })

    it('treats the same lock timeout raised by a body statement as fatal', async () => {
      await admin.unsafe("INSERT INTO notes (id, body) VALUES ('row', 'r')")
      const holder = openStore()
      const contender = openStore({ lockTimeoutMs: 30 })
      const held = barrier()
      const entered = barrier()
      const holding = holder.transact(async (tx) => {
        await tx.drizzle.run("UPDATE notes SET body = 'held' WHERE id = 'row'")
        entered.release()
        await held.wait()
      }, WS_A)
      await entered.wait()
      let bodyRuns = 0
      let raised: unknown
      await contender
        .transact(async (tx) => {
          bodyRuns += 1
          await tx.drizzle.run("UPDATE notes SET body = 'contended' WHERE id = 'row'")
        }, WS_B)
        .catch((error: unknown) => {
          raised = error
        })
      expect(raised).toMatchObject({ code: '55P03' })
      expect(bodyRuns).toBe(1)
      const driver = createPgStoreDriver({ url })
      expect(driver.classify(raised)).toBe('fatal')
      await driver.close()
      held.release()
      await holding
    })

    it('is busy when no pooled connection frees up in time', async () => {
      // Long enough to open the first connection on a loaded host; the refusal waits it out.
      const driver = createPgStoreDriver({ url, poolSize: 1, acquireTimeoutMs: 1_000 })
      opened.push(driver)
      const holding: DriverSession = await driver.open('read')
      const refused = await driver.open('read').catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(PgPoolTimeoutError)
      expect(driver.classify(refused)).toBe('busy')
      await holding.close()
      const next = await driver.open('read')
      await next.close()
    })

    it('is busy when the server refuses the connection', async () => {
      const target = new URL(url)
      target.port = String(await closedPort())
      const driver = createPgStoreDriver({ url: target.toString(), connectTimeoutSeconds: 2 })
      opened.push(driver)
      const refused = await driver.open('write').catch((error: unknown) => error)
      expect(refused).toMatchObject({ code: 'ECONNREFUSED' })
      expect(driver.classify(refused)).toBe('busy')
    })
  })

  describe('atomic batches and aborted transactions', () => {
    const insert = (id: string) => ({
      sql: 'INSERT INTO notes (id, body) VALUES ($1, $2)',
      params: [id, id],
      method: 'run' as const,
      intent: 'write' as const,
    })

    it('leaves the transaction as it was when a batch inside it fails', async () => {
      const store = openStore()
      await store.transact(async (tx) => {
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'one', '1')
        await expect(tx.drizzle.batch([insert('two'), insert('one')])).rejects.toMatchObject({
          code: '23505',
        })
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'three', '3')
      }, WS_A)
      expect(await bodies()).toEqual(['one', 'three'])
    })

    it('applies nothing of a root batch that fails', async () => {
      const store = openStore()
      await expect(store.drizzle.batch([insert('x'), insert('x')])).rejects.toMatchObject({
        code: '23505',
      })
      expect(await bodies()).toEqual([])
      await store.drizzle.batch([insert('y'), insert('z')])
      expect(await bodies()).toEqual(['y', 'z'])
    })

    it('refuses to report the commit of a transaction a failed statement aborted', async () => {
      const store = openStore()
      await expect(
        store.transact(async (tx) => {
          await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'kept?', 'k')
          await tx.drizzle
            .run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'kept?', 'k')
            .catch(() => undefined)
        }, WS_A),
      ).rejects.toBeInstanceOf(PgTransactionAbortedError)
      expect(await bodies()).toEqual([])
    })

    it('carries on after a failure caught inside a nested transaction', async () => {
      const store = openStore()
      await store.transact(async (tx) => {
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'outer', 'o')
        await tx
          .transact(async (inner) => {
            await inner.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'outer', 'o')
          })
          .catch(() => undefined)
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'after', 'a')
      }, WS_A)
      expect(await bodies()).toEqual(['after', 'outer'])
    })
  })

  describe('lanes', () => {
    it('reads beside an open write, from the last committed state', async () => {
      const store = openStore({ poolSize: 3 })
      const held = barrier()
      const entered = barrier()
      const writing = store.transact(async (tx) => {
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'open', 'o')
        entered.release()
        await held.wait()
      }, WS_A)
      await entered.wait()
      expect(await store.read(async (tx) => await tx.drizzle.all('SELECT id FROM notes'))).toEqual(
        [],
      )
      held.release()
      await writing
      expect(await store.drizzle.all('SELECT id FROM notes')).toEqual([{ id: 'open' }])
    })

    it('keeps one snapshot for a whole read body', async () => {
      const store = openStore({ poolSize: 3 })
      const seen = await store.read(async (tx) => {
        const before = await tx.drizzle.all('SELECT id FROM notes')
        await admin.unsafe("INSERT INTO notes (id, body) VALUES ('later', 'l')")
        const after = await tx.drizzle.all('SELECT id FROM notes')
        return { before, after }
      })
      expect(seen).toEqual({ before: [], after: [] })
    })

    it('runs reads in parallel up to the pool size minus one', async () => {
      const store = openStore({ poolSize: 3 })
      expect(store.scheduler).toBeDefined()
      const held = barrier()
      let inside = 0
      let most = 0
      const reads = [1, 2, 3].map(() =>
        store.read(async (tx) => {
          await tx.drizzle.get('SELECT 1 AS one')
          inside += 1
          most = Math.max(most, inside)
          await held.wait()
          inside -= 1
        }),
      )
      await eventually(() => inside === 2)
      await settle()
      expect(inside).toBe(2)
      held.release()
      await Promise.all(reads)
      expect(most).toBe(2)
    })

    it('reads the committed view outside an open write on another connection', async () => {
      const store = openStore({ poolSize: 3 })
      const outside = await store.transact(async (tx) => {
        await tx.drizzle.run('INSERT INTO notes (id, body) VALUES ($1, $2)', 'mine', 'm')
        return await store.outsideTransaction(
          async (view) => await view.drizzle.all('SELECT id FROM notes'),
        )
      }, WS_A)
      expect(outside).toEqual([])
    })

    it('refuses a write on a read session', async () => {
      const driver = createPgStoreDriver({ url })
      opened.push(driver)
      const session = await driver.open('read')
      await expect(
        session.execute({
          sql: "INSERT INTO notes (id, body) VALUES ('no', 'n')",
          params: [],
          method: 'run',
          intent: 'write',
        }),
      ).rejects.toThrow(/cannot write on a reader session/)
      await session.close()
    })
  })

  describe('result shapes', () => {
    it('gives run, get and all the shapes the bun:sqlite driver gives', async () => {
      const database = openDatabase(':memory:')
      database.exec('CREATE TABLE notes (id text PRIMARY KEY, body text)')
      const lite = createBunStoreExecutor({ database, startOpen: true })
      opened.push(lite)
      const pg = openStore()
      const engines = [
        { client: lite.drizzle, p: (_n: number) => '?' },
        { client: pg.drizzle, p: (n: number) => `$${n}` },
      ]
      const results = []
      for (const { client, p } of engines) {
        const inserted = await client.run(
          `INSERT INTO notes (id, body) VALUES (${p(1)}, ${p(2)})`,
          'a',
          'x',
        )
        const updated = await client.run(
          `UPDATE notes SET body = ${p(1)} WHERE id = ${p(2)}`,
          'y',
          'none',
        )
        results.push({
          inserted: inserted.changes,
          updated: updated.changes,
          found: await client.get(`SELECT id, body FROM notes WHERE id = ${p(1)}`, 'a'),
          missing: await client.get(`SELECT id, body FROM notes WHERE id = ${p(1)}`, 'none'),
          all: await client.all('SELECT id, body FROM notes ORDER BY id'),
          returned: await client.writeAll(
            `INSERT INTO notes (id, body) VALUES (${p(1)}, ${p(2)}) RETURNING id`,
            'b',
            'z',
          ),
        })
      }
      expect(results[1]).toEqual(results[0])
      expect(results[1]).toEqual({
        inserted: 1,
        updated: 0,
        found: { id: 'a', body: 'x' },
        missing: undefined,
        all: [{ id: 'a', body: 'x' }],
        returned: [{ id: 'b' }],
      })
    })

    it('gives the drizzle shim SQLite raw shapes for get, all, values and run', async () => {
      const store = openStore()
      const db = buildPgStoreDrizzle(store.drizzle, {})
      await store.drizzle.run("INSERT INTO notes (id, body) VALUES ('a', 'x'), ('b', 'y')")
      expect(await db.get(sql`SELECT id FROM notes WHERE id = 'a'`)).toEqual({ id: 'a' })
      expect(await db.get(sql`SELECT id FROM notes WHERE id = 'none'`)).toBeUndefined()
      expect(await db.all(sql`SELECT id FROM notes ORDER BY id`)).toEqual([
        { id: 'a' },
        { id: 'b' },
      ])
      expect(await db.values(sql`SELECT id, body FROM notes ORDER BY id`)).toEqual([
        ['a', 'x'],
        ['b', 'y'],
      ])
      const run = await db.run(sql`UPDATE notes SET body = 'z'`)
      expect(run).toMatchObject({ rows: [], changes: 2 })
    })
  })
})
