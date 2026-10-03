import { openDatabase } from '@podium/runtime/sqlite'
import { eq, sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { types } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createBunSqliteDriver } from './bun-driver'
import { queryClientOver, type Statement } from './driver'
import { storeQueriesOver } from './sync-drizzle'

const notes = sqliteTable('intent_notes', {
  id: integer('id').primaryKey(),
  body: text('note_body').notNull(),
})
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture() {
  const database = openDatabase(':memory:')
  database.exec('CREATE TABLE intent_notes (id INTEGER PRIMARY KEY, note_body TEXT NOT NULL)')
  const driver = createBunSqliteDriver({ database })
  const session = await driver.open('write')
  cleanup.push(async () => {
    await session.close()
    await driver.close()
  })
  const statements: Statement[] = []
  const client = queryClientOver(
    async (statement) => {
      statements.push(statement)
      return await session.execute(statement)
    },
    async (batch) => {
      statements.push(...batch)
      return await session.executeBatch(batch)
    },
  )
  const queries = storeQueriesOver(client, async (fn) => await fn(client))
  return { db: queries.rootDb, queries, statements }
}

describe('builder-declared statement intent', () => {
  it('keeps SELECT reads distinct from RETURNING writes with the same terminals', async () => {
    const { db, statements } = await fixture()
    expect(await db.insert(notes).values({ id: 1, body: 'first' }).returning().all()).toEqual([
      { id: 1, body: 'first' },
    ])
    expect(await db.select().from(notes).get()).toEqual({ id: 1, body: 'first' })
    expect(await db.select().from(notes).all()).toEqual([{ id: 1, body: 'first' }])
    expect(await db.update(notes).set({ body: 'second' }).returning().get()).toEqual({
      id: 1,
      body: 'second',
    })
    expect(await db.delete(notes).returning().all()).toEqual([{ id: 1, body: 'second' }])
    expect(await db.select().from(notes).get()).toBeUndefined()
    expect(statements.map(({ method, intent }) => [method, intent])).toEqual([
      ['all', 'write'],
      ['get', 'read'],
      ['all', 'read'],
      ['get', 'write'],
      ['all', 'write'],
      ['get', 'read'],
    ])
  })

  it('makes the planted insert .run() to .all() mutation unable to change intent', async () => {
    const { db, statements } = await fixture()
    await db.insert(notes).values({ id: 1, body: 'run' }).run()
    await db.insert(notes).values({ id: 2, body: 'all' }).all()
    expect(statements.map(({ method, intent }) => [method, intent])).toEqual([
      ['run', 'write'],
      ['all', 'write'],
    ])
    expect(await db.select().from(notes).orderBy(notes.id)).toEqual([
      { id: 1, body: 'run' },
      { id: 2, body: 'all' },
    ])
  })

  it('retains metadata across prepared-query reuse, placeholders and interleaving', async () => {
    const { db, statements } = await fixture()
    const insert = db
      .insert(notes)
      .values({ id: sql.placeholder('id'), body: 'prepared' })
      .returning()
      .prepare()
    const select = db
      .select()
      .from(notes)
      .where(eq(notes.id, sql.placeholder('id')))
      .prepare()
    await insert.all({ id: 1 })
    expect(await select.get({ id: 1 })).toEqual({ id: 1, body: 'prepared' })
    await Promise.all([select.all({ id: 1 }), insert.all({ id: 2 })])
    await select.run({ id: 2 })
    expect(statements.map(({ intent }) => intent)).toEqual([
      'write',
      'read',
      'read',
      'write',
      'read',
    ])
  })

  it('defaults raw execution to write, including raw SELECT', async () => {
    const { db, statements } = await fixture()
    await db.run(sql`insert into intent_notes values (1, 'raw')`)
    await db.all(sql`select * from intent_notes`)
    await db.get(sql`select * from intent_notes`)
    expect(statements.map(({ intent }) => intent)).toEqual(['write', 'write', 'write'])
  })

  it('returns plain raw snapshots with every named data cell', async () => {
    const { db } = await fixture()
    await db.insert(notes).values({ id: 1, body: 'search result' }).run()
    type RawRow = { id: number; note_body: string }
    const row = await db.get<RawRow>(sql`select * from intent_notes`)
    const rows = await db.all<RawRow>(sql`select * from intent_notes`)
    for (const result of [row!, rows[0]!]) {
      expect(types.isProxy(result)).toBe(false)
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(result.id).toBe(1)
      expect(result.note_body).toBe('search result')
      expect('note_body' in result).toBe(true)
      expect(Object.getOwnPropertyDescriptor(result, 'note_body')?.value).toBe('search result')
      expect(Object.keys(result)).toEqual(['id', 'note_body'])
      expect(Object.values(result)).toEqual([1, 'search result'])
      expect(JSON.stringify(result)).toBe('{"id":1,"note_body":"search result"}')
    }
    expect(await db.get(sql`select * from intent_notes where id = 2`)).toBeUndefined()
    const reserved = await db.get<{ length: string; map: null }>(sql`select 'column' as length, null as map`)
    expect(reserved).toEqual({ length: 'column', map: null })
  })

  it('keeps prepared builder values positional without constructing named properties', async () => {
    const { db } = await fixture()
    await db.insert(notes).values({ id: 1, body: 'builder' }).run()
    const prepared = db.select({ body: notes.body, id: notes.id }).from(notes).prepare()
    const values = await prepared.values()
    expect(values).toEqual([['builder', 1]])
    expect(types.isProxy(values[0])).toBe(false)
    expect(Object.hasOwn(values[0]!, 'note_body')).toBe(false)
    expect(Object.hasOwn(values[0]!, 'id')).toBe(false)
    expect(await prepared.get()).toEqual({ body: 'builder', id: 1 })
  })

  it('captures named cells once instead of retaining a live source-row lookup', async () => {
    let reads = 0
    let current = 'first'
    const row = {
      id: 1,
      get note_body() {
        reads += 1
        return current
      },
    }
    const client = queryClientOver(
      async () => ({ rows: [row] }),
      async () => [],
    )
    const db = storeQueriesOver(client, async (fn) => await fn(client)).rootDb
    const result = await db.get<{ id: number; note_body: string }>(sql`select id, note_body`)
    current = 'changed'
    expect(result?.id).toBe(1)
    expect(result?.note_body).toBe('first')
    expect(reads).toBe(1)
    expect(types.isProxy(result)).toBe(false)
  })

  it('carries per-item intent through read-only and mixed atomic batches', async () => {
    const { db, statements } = await fixture()
    // StoreDrizzle hides the proxy-only batch API; exercise its runtime adapter.
    const batchDb = db as unknown as SqliteRemoteDatabase
    expect(
      await batchDb.batch([
        db.insert(notes).values({ id: 1, body: 'batch' }).returning(),
        db.select().from(notes),
        db.update(notes).set({ body: 'changed' }).returning(),
      ]),
    ).toEqual([
      [{ id: 1, body: 'batch' }],
      [{ id: 1, body: 'batch' }],
      [{ id: 1, body: 'changed' }],
    ])
    expect(await batchDb.batch([db.select().from(notes), db.select().from(notes)])).toEqual([
      [{ id: 1, body: 'changed' }],
      [{ id: 1, body: 'changed' }],
    ])
    expect(statements.map(({ intent }) => intent)).toEqual([
      'write',
      'read',
      'write',
      'read',
      'read',
    ])
  })

  it('uses builder intent on the transaction-bound database too', async () => {
    const { queries, statements } = await fixture()
    await queries.createOrJoinTransaction(async () => {
      await queries.rootDb.insert(notes).values({ id: 1, body: 'transaction' }).all()
      expect(await queries.rootDb.select().from(notes)).toEqual([{ id: 1, body: 'transaction' }])
    })
    expect(statements.map(({ intent }) => intent)).toEqual(['write', 'read'])
  })
})
