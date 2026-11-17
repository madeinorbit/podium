/**
 * Native Postgres types read back as SQLite's values [POD-6979, POD-6958 design 2.3, 2.10].
 *
 * The parser and serializer cases run on every leg. The round trips need Postgres and
 * run on the `server-store-pg` lane: one table per engine in the native types of 2.3,
 * the same definition source built on each (the Postgres table cast to its SQLite twin's
 * type, as `bindingFor` casts), and every read compared with SQLite's.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { asc, count, eq, gt, lt, max, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  pgTable,
  text as pgText,
  timestamp,
} from 'drizzle-orm/pg-core'
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clonePgTestDatabase, testStoreEngine } from '../../test-support/pg-test-database'
import { createBunStoreExecutor } from './bun-driver'
import type { QueryClient } from './driver'
import type { RootStoreExecutor } from './executor'
import { createPgStoreExecutor } from './pg-driver'
import { buildPgStoreDrizzle } from './pg-drizzle'
import {
  Int8RangeError,
  isCanonicalTimestamp,
  NonCanonicalTimestampError,
  parseInt8,
  parseTimestamptz,
  serializeJson,
  serializeTimestamptz,
  strictTimestampsFromEnvironment,
  TIMESTAMP_AFTER_ALL,
  TIMESTAMP_BEFORE_ALL,
} from './pg-types'
import { type StoreDrizzle, storeQueriesOver } from './sync-drizzle'

describe('timestamptz output parsing', () => {
  it.each([
    ['2026-11-16 10:00:00+00', '2026-11-16T10:00:00.000Z'],
    ['2026-11-16 10:00:00.12+00', '2026-11-16T10:00:00.120Z'],
    ['2026-11-16 10:00:00.123+00', '2026-11-16T10:00:00.123Z'],
    ['2026-11-16 10:00:00.123456+00', '2026-11-16T10:00:00.123Z'],
    ['2026-11-16 11:00:00.5+01', '2026-11-16T10:00:00.500Z'],
    ['2026-11-16 15:30:00+05:30', '2026-11-16T10:00:00.000Z'],
    ['2026-11-16 04:00:00-06', '2026-11-16T10:00:00.000Z'],
    ['1890-01-01 00:53:28+00:53:28', '1890-01-01T00:00:00.000Z'],
    ['0099-06-01 00:00:00+00', '0099-06-01T00:00:00.000Z'],
    ['0044-03-15 12:00:00+00 BC', '-000043-03-15T12:00:00.000Z'],
    ['10000-01-01 00:00:00+00', '+010000-01-01T00:00:00.000Z'],
  ])('%s reads as %s', (printed, iso) => {
    expect(parseTimestamptz(printed)).toBe(iso)
  })

  it('reads the infinities as the sentinels', () => {
    expect(parseTimestamptz('-infinity')).toBe(TIMESTAMP_BEFORE_ALL)
    expect(parseTimestamptz('infinity')).toBe(TIMESTAMP_AFTER_ALL)
  })

  it('refuses output it does not understand', () => {
    expect(() => parseTimestamptz('2026-11-16T10:00:00Z')).toThrow(/unrecognised/)
  })

  it('keeps the sentinels in the order of the strings they stand for', () => {
    const values = ['2026-01-01T00:00:00.000Z', TIMESTAMP_AFTER_ALL, TIMESTAMP_BEFORE_ALL]
    expect([...values].sort()).toEqual([
      TIMESTAMP_BEFORE_ALL,
      '2026-01-01T00:00:00.000Z',
      TIMESTAMP_AFTER_ALL,
    ])
  })
})

describe('timestamptz parameters', () => {
  it('sends the sentinels as the infinities and canonical text as it is', () => {
    expect(serializeTimestamptz('', true)).toBe('-infinity')
    expect(serializeTimestamptz('￿', true)).toBe('infinity')
    expect(serializeTimestamptz('2026-11-16T10:00:00.000Z', true)).toBe('2026-11-16T10:00:00.000Z')
    expect(serializeTimestamptz(new Date(0), true)).toBe('1970-01-01T00:00:00.000Z')
  })

  it.each([
    '2026-11-16T10:00:00Z',
    '2026-11-16T10:00:00.000+00:00',
    '2026-11-16T10:00:00.123456Z',
    '2026-11-16 10:00:00.000Z',
    '2026-02-30T00:00:00.000Z',
  ])('strict mode refuses %s and lax mode sends it as it is', (value) => {
    expect(isCanonicalTimestamp(value)).toBe(false)
    expect(() => serializeTimestamptz(value, true)).toThrow(NonCanonicalTimestampError)
    expect(serializeTimestamptz(value, false)).toBe(value)
  })

  it('strict mode refuses a number', () => {
    expect(() => serializeTimestamptz(1_700_000_000_000, true)).toThrow(NonCanonicalTimestampError)
  })

  it('is strict on the Postgres test leg unless told otherwise', () => {
    expect(strictTimestampsFromEnvironment({ PODIUM_TEST_STORE_ENGINE: 'pg' })).toBe(true)
    expect(strictTimestampsFromEnvironment({})).toBe(false)
    expect(
      strictTimestampsFromEnvironment({
        PODIUM_TEST_STORE_ENGINE: 'pg',
        PODIUM_PG_STRICT_TIMESTAMPS: '0',
      }),
    ).toBe(false)
    expect(strictTimestampsFromEnvironment({ PODIUM_PG_STRICT_TIMESTAMPS: '1' })).toBe(true)
  })
})

describe('int8 and json conversions', () => {
  it('reads int8 as a number up to 2^53 and refuses beyond it', () => {
    expect(parseInt8('9007199254740992')).toBe(2 ** 53)
    expect(parseInt8('-9007199254740992')).toBe(-(2 ** 53))
    expect(parseInt8('42')).toBe(42)
    expect(() => parseInt8('9007199254740993')).toThrow(Int8RangeError)
    expect(() => parseInt8('-9007199254740993')).toThrow(Int8RangeError)
  })

  it('sends JSON text as it is', () => {
    expect(serializeJson('{"b":1,"a":2,"b":3}')).toBe('{"b":1,"a":2,"b":3}')
    expect(serializeJson({ a: 1 })).toBe('{"a":1}')
  })
})

// ---------------------------------------------------------------------------
// Round trips on both engines
// ---------------------------------------------------------------------------

const sqliteSamples = sqliteTable('type_samples', {
  id: text('id').primaryKey(),
  at: text('at'),
  big: integer('big'),
  flag: integer('flag', { mode: 'boolean' }),
  doc: text('doc'),
  ratio: real('ratio'),
})

/** JSON kept as its text both ways (POD-6978's `jsonText`). */
const jsonText = customType<{ data: string; driverData: string }>({ dataType: () => 'json' })

const pgSamples = pgTable('type_samples', {
  id: pgText('id').primaryKey(),
  at: timestamp('at', { withTimezone: true, precision: 3, mode: 'string' }),
  big: bigint('big', { mode: 'number' }),
  flag: boolean('flag'),
  doc: jsonText('doc'),
  ratio: doublePrecision('ratio'),
})

type Samples = typeof sqliteSamples

const SQLITE_DDL =
  'CREATE TABLE type_samples (id text PRIMARY KEY, at text, big integer, flag integer, ' +
  'doc text, ratio real)'
const PG_DDL =
  'CREATE TABLE type_samples (id text COLLATE "C" PRIMARY KEY, at timestamptz(3), big bigint, ' +
  'flag boolean, doc json, ratio double precision)'

const ODD_JSON = '{"b":1,"a":[1, 2],"b":3}'
const NUL_ESCAPE_JSON = '{"x":"\\u0000"}'

const ROWS = [
  {
    id: 'a',
    at: '2026-11-16T10:00:00.000Z',
    big: 2 ** 53,
    flag: true,
    doc: ODD_JSON,
    ratio: 0.1,
  },
  {
    id: 'b',
    at: '2026-11-16T10:00:00.120Z',
    big: -7,
    flag: false,
    doc: NUL_ESCAPE_JSON,
    ratio: -2.5,
  },
  { id: 'c', at: TIMESTAMP_BEFORE_ALL, big: 0, flag: false, doc: '[]', ratio: 0 },
  { id: 'd', at: TIMESTAMP_AFTER_ALL, big: 1, flag: true, doc: 'null', ratio: 1 },
  { id: 'e', at: null, big: null, flag: null, doc: null, ratio: null },
]

/** One source per definition, built on either engine's table. */
const definitions = {
  insert: (db: StoreDrizzle, t: Samples) =>
    db
      .insert(t)
      .values({
        id: sql.placeholder('id'),
        at: sql.placeholder('at'),
        big: sql.placeholder('big'),
        flag: sql.placeholder('flag'),
        doc: sql.placeholder('doc'),
        ratio: sql.placeholder('ratio'),
      })
      .prepare(),
  byId: (db: StoreDrizzle, t: Samples) =>
    db
      .select()
      .from(t)
      .where(eq(t.id, sql.placeholder('id')))
      .prepare(),
  inTimeOrder: (db: StoreDrizzle, t: Samples) =>
    db
      .select({ id: t.id, at: t.at })
      .from(t)
      .where(sql`${t.at} is not null`)
      .orderBy(asc(t.at), asc(t.id))
      .prepare(),
  after: (db: StoreDrizzle, t: Samples) =>
    db
      .select({ id: t.id })
      .from(t)
      .where(gt(t.at, sql.placeholder('after')))
      .orderBy(asc(t.id))
      .prepare(),
  latestFinite: (db: StoreDrizzle, t: Samples) =>
    db
      .select({ latest: max(t.at), rows: count() })
      .from(t)
      .where(lt(t.at, TIMESTAMP_AFTER_ALL))
      .prepare(),
  flags: (db: StoreDrizzle, t: Samples) =>
    db
      .select({ id: t.id, on: sql<number>`(${t.flag} = ${true})`.mapWith(Number) })
      .from(t)
      .where(sql`${t.flag} is not null`)
      .orderBy(asc(t.id))
      .prepare(),
}

const RAW_READ = sql`select id, at, big, doc, ratio from type_samples order by id`

interface Engine {
  readonly executor: RootStoreExecutor<QueryClient>
  readonly db: StoreDrizzle
  readonly t: Samples
}

function sqliteEngine(): Engine {
  const database = openDatabase(':memory:')
  database.exec(SQLITE_DDL)
  const executor = createBunStoreExecutor({ database, startOpen: true })
  const queries = storeQueriesOver(
    executor.drizzle,
    async (fn, context) => await executor.transact(async () => await fn(), context),
  )
  return { executor, db: queries.rootDb, t: sqliteSamples }
}

async function pgEngine(url: string, strictTimestamps: boolean): Promise<Engine> {
  const executor = createPgStoreExecutor({ url, poolSize: 3, startOpen: true, strictTimestamps })
  const db = buildPgStoreDrizzle(executor.drizzle, { typeSamples: pgSamples })
  return { executor, db, t: pgSamples as unknown as Samples }
}

describe.runIf(testStoreEngine() === 'pg')('native types on both engines', () => {
  let lite: Engine
  let pg: Engine
  let lax: Engine
  let url: string

  beforeAll(async () => {
    url = (await clonePgTestDatabase('file')).url
    lite = sqliteEngine()
    pg = await pgEngine(url, true)
    lax = await pgEngine(url, false)
    await pg.executor.drizzle.run(PG_DDL)
    for (const engine of [lite, pg]) {
      const insert = definitions.insert(engine.db, engine.t)
      for (const row of ROWS) await insert.run(row)
    }
  })

  afterAll(async () => {
    await lite?.executor.close()
    await pg?.executor.close()
    await lax?.executor.close()
  })

  const both = async <T>(read: (engine: Engine) => Promise<T>): Promise<[T, T]> => [
    await read(lite),
    await read(pg),
  ]

  it('reads every class back through the builder exactly as SQLite does', async () => {
    for (const { id } of ROWS) {
      const [onSqlite, onPg] = await both(
        async (engine) => await definitions.byId(engine.db, engine.t).get({ id }),
      )
      expect(onPg).toEqual(onSqlite)
    }
    const row = await definitions.byId(pg.db, pg.t).get({ id: 'a' })
    expect(row).toEqual(ROWS[0])
  })

  it('keeps JSON text byte for byte: key order, spacing, duplicate keys, the \\u0000 escape', async () => {
    const docs = await both(async (engine) =>
      (await definitions.byId(engine.db, engine.t).all({ id: 'a' })).map((row) => row.doc),
    )
    expect(docs).toEqual([[ODD_JSON], [ODD_JSON]])
    const escaped = await definitions.byId(pg.db, pg.t).get({ id: 'b' })
    expect(escaped?.doc).toBe(NUL_ESCAPE_JSON)
  })

  it('reads raw sql exactly as SQLite does for timestamps, int8, JSON and floats', async () => {
    const [onSqlite, onPg] = await both(async (engine) => await engine.db.all(RAW_READ))
    expect(onPg).toEqual(onSqlite)
  })

  it('reads bytes as the plain Uint8Array bun:sqlite gives', async () => {
    const bytes = new Uint8Array([0, 1, 255])
    const [onSqlite, onPg] = await both(async (engine) =>
      engine === pg
        ? await engine.executor.drizzle.get('select $1::bytea as bytes', bytes)
        : await engine.executor.drizzle.get('select ? as bytes', bytes),
    )
    expect(onPg).toEqual(onSqlite)
    expect(Object.getPrototypeOf((onPg as { bytes: Uint8Array }).bytes)).toBe(Uint8Array.prototype)
  })

  it('orders the sentinels before and after every real timestamp', async () => {
    const [onSqlite, onPg] = await both(
      async (engine) => await definitions.inTimeOrder(engine.db, engine.t).all(),
    )
    expect(onPg).toEqual(onSqlite)
    expect(onPg.map((row) => row.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('compares a sentinel parameter where its string would compare', async () => {
    for (const after of [TIMESTAMP_BEFORE_ALL, '2026-11-16T10:00:00.000Z']) {
      const [onSqlite, onPg] = await both(
        async (engine) => await definitions.after(engine.db, engine.t).all({ after }),
      )
      expect(onPg).toEqual(onSqlite)
    }
  })

  it('reads a timestamp aggregate and a count as SQLite does', async () => {
    const [onSqlite, onPg] = await both(
      async (engine) => await definitions.latestFinite(engine.db, engine.t).get(),
    )
    expect(onPg).toEqual(onSqlite)
    expect(onPg).toEqual({ latest: '2026-11-16T10:00:00.120Z', rows: 3 })
  })

  it('gives a truth-valued fragment declared with mapWith(Number) as 0/1 on both', async () => {
    const [onSqlite, onPg] = await both(
      async (engine) => await definitions.flags(engine.db, engine.t).all(),
    )
    expect(onPg).toEqual(onSqlite)
    expect(onPg.map((row) => row.on)).toEqual([1, 0, 0, 1])
  })

  it('differs only where the design says: a raw boolean is 1 on SQLite and true on Postgres', async () => {
    const [onSqlite, onPg] = await both(
      async (engine) => await engine.db.get(sql`select flag from type_samples where id = 'a'`),
    )
    expect(onSqlite).toEqual({ flag: 1 })
    expect(onPg).toEqual({ flag: true })
  })

  it('reads timestamps in toISOString form whatever the session time zone', async () => {
    const read = await pg.executor.transact(async (tx) => {
      await tx.drizzle.run("SET LOCAL TIME ZONE 'Europe/Berlin'")
      return await tx.drizzle.all("select at, at::text as printed from type_samples where id = 'b'")
    })
    expect(read).toEqual([{ at: '2026-11-16T10:00:00.120Z', printed: '2026-11-16 11:00:00.12+01' }])
  })

  it('reads int8 at 2^53 and refuses a value beyond it', async () => {
    await pg.executor.drizzle.run(
      "insert into type_samples (id, big) values ('huge', $1)",
      9007199254740993n,
    )
    await expect(
      pg.executor.drizzle.get("select big from type_samples where id = 'huge'"),
    ).rejects.toThrow(Int8RangeError)
    expect(await pg.executor.drizzle.get("select big from type_samples where id = 'a'")).toEqual({
      big: 2 ** 53,
    })
    await pg.executor.drizzle.run("delete from type_samples where id = 'huge'")
  })

  it('refuses a NUL character in text, which SQLite stores', async () => {
    const insert = definitions.insert(lite.db, lite.t)
    await insert.run({ ...ROWS[4], id: 'nul\u0000' })
    expect(await definitions.byId(lite.db, lite.t).get({ id: 'nul\u0000' })).toBeDefined()
    await expect(
      definitions.insert(pg.db, pg.t).run({ ...ROWS[4], id: 'nul\u0000' }),
    ).rejects.toThrow()
  })

  it('refuses a non-canonical timestamp in strict mode; lax mode lets Postgres normalise it', async () => {
    const strictInsert = definitions.insert(pg.db, pg.t)
    await expect(
      strictInsert.run({ ...ROWS[4], id: 'loose', at: '2026-11-16T12:00:00+02:00' }),
    ).rejects.toThrow(NonCanonicalTimestampError)
    await definitions
      .insert(lax.db, lax.t)
      .run({ ...ROWS[4], id: 'loose', at: '2026-11-16T12:00:00+02:00' })
    expect(await definitions.byId(lax.db, lax.t).get({ id: 'loose' })).toMatchObject({
      at: '2026-11-16T10:00:00.000Z',
    })
    await lax.executor.drizzle.run("delete from type_samples where id = 'loose'")
  })
})
