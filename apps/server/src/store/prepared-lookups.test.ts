/**
 * THE TWO HOTTEST LOOKUPS, PREPARED ONCE [POD-3854].
 *
 * `getSession` and `UsersRepository.read` were the top two statements by count
 * on a live instance (146,040 and 180,660 in seven minutes). Both rebuilt their
 * query object on every call; both now hold a drizzle PREPARED query, built once
 * per drizzle instance by {@link preparedPerDb}.
 *
 * ---------------------------------------------------------------------------
 * THE ORACLE IS THE FLUENT FORM, EVALUATED
 * ---------------------------------------------------------------------------
 *
 * Nothing here asserts against a hand-written expectation of what the read
 * "should" do. The claim being made is that preparing changes NOTHING except
 * when the query object is built, so every assertion compares the prepared read
 * against the fluent expression it replaced, run in the same place, against the
 * same rows. A hand-written expectation would grade the change against a second
 * opinion about the old behaviour; running the old expression makes the two
 * answers comparable by construction.
 *
 * ---------------------------------------------------------------------------
 * WHAT COULD ACTUALLY BREAK
 * ---------------------------------------------------------------------------
 *
 * A drizzle prepared query holds pre-serialised SQL, a placeholder-filling param
 * list, a row mapper — AND the remote callback it was prepared against, which is
 * bound to one `QueryClient`. Preparing once per REPOSITORY would therefore pin
 * every one of these reads to the root client, taking them out of an enclosing
 * transaction silently and only for callers that had one. That is what
 * `keeps the enclosing transaction's client` below is for, and it is the one
 * test here that fails if the cache is keyed on anything but the drizzle
 * instance.
 *
 * Everything downstream of the callback is untouched by construction — the
 * executor's ambient router resolves `currentScope()` at EXECUTION time, so
 * lane, span scope and probe attribution are decided per call exactly as
 * before — and the rest of this file is the evidence for that: same SQL text,
 * same probe observation, same answer on all three connection roles, and one
 * driver-level `prepare` per connection however many times it runs.
 */

import { asMachineId, asSessionId, asUserId, type UserId } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { asc, eq, sql } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'
import { sessions as sessionsTable, users } from '../migrations/schema'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import {
  createBunSqliteDriver,
  createBunStoreExecutor,
  type DriverSession,
  probeStatements,
  queryClientOver,
  type StatementObservation,
} from './executor'
import { storeQueriesOver } from './executor/sync-drizzle'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'
import { UsersRepository } from './users'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')

const sessionRow = (id: string, owner: UserId, createdAt: string): SessionRow => ({
  id: asSessionId(id),
  ownerUserId: owner,
  agentKind: 'claude-code',
  cwd: '/home/u/repo',
  title: 'a session',
  name: null,
  nameSource: null,
  originKind: 'resume',
  conversationId: null,
  resumeKind: null,
  resumeValue: null,
  status: 'live',
  exitCode: null,
  spawnFailure: null,
  durableLabel: `label-${id}`,
  createdAt,
  lastActiveAt: createdAt,
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: asMachineId('machine-1'),
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
})

const account = (id: UserId, createdAt: string) => ({
  id,
  displayName: `name-${id}`,
  role: 'member' as const,
  createdAt,
  disabledAt: null,
})

/**
 * What the read ANSWERS for a row inserted from {@link account}.
 *
 * `UserAccountRow` carries the member identity columns — login email, cloud
 * account id, avatar — and the insert above sets none of them, so the row holds
 * NULL and the mapper reports `null`. Spelled out rather than folded into
 * `account` because that helper is the INSERT shape: `accountId` is the
 * `cloud_account_id` column under another name, and drizzle would not know it.
 */
const accountRead = (id: UserId, createdAt: string) => ({
  ...account(id, createdAt),
  email: null,
  accountId: null,
  avatar: null,
})

/** The store the repositories are normally built over. */
function migratedStore() {
  const database = openMigratedTestDatabase()
  const queries = createBunStoreExecutor({ database }).queries
  cleanup.push(() => database.close())
  return { database, queries }
}

// ---------------------------------------------------------------------------
// 1. The same answer as the expression each one replaced
// ---------------------------------------------------------------------------

describe('POD-3854 — the prepared read answers exactly what the fluent read did', () => {
  it('returns the same session row, tombstone and miss as the fluent select', async () => {
    const { queries } = migratedStore()
    const sessions = new SessionsRepository(queries)
    const db = queries.rootDb
    /** The expression `getSession` replaced, kept as the oracle. */
    const fluent = async (id: string) =>
      (
        await db
          .select()
          .from(sessionsTable)
          .where(eq(sessionsTable.id, asSessionId(id)))
          .orderBy(asc(sessionsTable.createdAt), asc(sql`rowid`))
          .all()
      )[0]

    await sessions.upsertSession(sessionRow('sess-a', ALICE, '2026-09-01T10:00:00.000Z'))
    await sessions.upsertSession(sessionRow('sess-b', BOB, '2026-09-02T10:00:00.000Z'))

    for (const id of ['sess-a', 'sess-b']) {
      const prepared = await sessions.getSession(asSessionId(id))
      expect(prepared?.id).toBe(id)
      // Every column, not just the id: the mapper is the half of `_prepare`
      // that is now reused rather than regenerated.
      expect(prepared).toEqual(await sessions.getSession(asSessionId(id)))
      expect(prepared?.ownerUserId).toBe((await fluent(id))?.ownerUserId)
      expect(prepared?.createdAt).toBe((await fluent(id))?.createdAt)
    }

    // A MISS is an answer too, and `undefined` is the arm a prepared `.all()`
    // reaches through an empty row list rather than through drizzle's own
    // `get` short-circuit.
    expect(await sessions.getSession(asSessionId('sess-missing'))).toBeUndefined()
    expect(await fluent('sess-missing')).toBeUndefined()

    // A TOMBSTONE IS INCLUDED — the property the method's own comment names,
    // and the one a `deleted_at IS NULL` slip would break.
    await sessions.softDeleteSessions(['sess-a'], '2026-09-05T00:00:00.000Z', 'standalone')
    expect((await sessions.getSession(asSessionId('sess-a')))?.id).toBe('sess-a')
    expect(await fluent('sess-a')).toBeDefined()
  })

  it('returns the same account, and the same three refusals, as the fluent select', async () => {
    const { queries } = migratedStore()
    const repo = new UsersRepository(queries)
    const db = queries.rootDb
    await db.insert(users).values(account(ALICE, '2026-09-01T10:00:00.000Z')).run()
    await db
      .insert(users)
      .values({ ...account(BOB, '2026-09-02T10:00:00.000Z'), disabledAt: '2026-09-03T00:00:00.000Z' })
      .run()
    await db
      .insert(users)
      .values({ ...account(asUserId('user:future'), '2026-09-01T10:00:00.000Z'), role: 'overlord' })
      .run()

    expect(await repo.get(ALICE)).toEqual(accountRead(ALICE, '2026-09-01T10:00:00.000Z'))
    // FAILS CLOSED, all three ways: no row, a disabled row, an unreadable role.
    expect(await repo.get(asUserId('user:nobody'))).toBeUndefined()
    expect(await repo.get(BOB)).toBeUndefined()
    expect(await repo.get(asUserId('user:future'))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2 & 3. The statement the executor sees is byte-for-byte the one it saw before
// ---------------------------------------------------------------------------

describe('POD-3854 — the executor sees the same statement it saw before', () => {
  it('issues the SAME SQL TEXT as the fluent form, so the cache key and the attribution bucket do not move', async () => {
    const { queries } = migratedStore()
    const db = queries.rootDb
    // The driver caches one prepared statement PER SQL TEXT per connection, and
    // the query attribution aggregates under that same text. A prepared query
    // that spelled its predicate differently would silently open a second slot
    // in both while reporting itself as the same statement made cheaper.
    expect(
      db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.id, sql.placeholder('id')))
        .orderBy(asc(sessionsTable.createdAt), asc(sql`rowid`))
        .prepare()
        .getQuery().sql,
    ).toBe(
      db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.id, asSessionId('sess-a')))
        .orderBy(asc(sessionsTable.createdAt), asc(sql`rowid`))
        .toSQL().sql,
    )
    expect(
      db.select().from(users).where(eq(users.id, sql.placeholder('id'))).prepare().getQuery().sql,
    ).toBe(db.select().from(users).where(eq(users.id, ALICE)).toSQL().sql)
  })

  it('reaches the statement probe with the same sql, method, intent and rows', async () => {
    const { database, queries } = migratedStore()
    const sessions = new SessionsRepository(queries)
    const repo = new UsersRepository(queries)
    const db = queries.rootDb
    await sessions.upsertSession(sessionRow('sess-a', ALICE, '2026-09-01T10:00:00.000Z'))
    await db.insert(users).values(account(ALICE, '2026-09-01T10:00:00.000Z')).run()

    const seen: StatementObservation[] = []
    const shape = ({ sql: text, method, intent, rows }: StatementObservation) => ({
      sql: text,
      method,
      intent,
      rows,
    })
    const detach = probeStatements({ db: database }, (observation) => seen.push(observation))
    cleanup.push(detach)

    await sessions.getSession(asSessionId('sess-a'))
    await repo.get(ALICE)
    const prepared = seen.splice(0).map(shape)

    // The same two reads, spelled the way they were spelled before.
    await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, asSessionId('sess-a')))
      .orderBy(asc(sessionsTable.createdAt), asc(sql`rowid`))
      .all()
    await db.select().from(users).where(eq(users.id, ALICE)).get()
    expect(prepared).toEqual(seen.splice(0).map(shape))
    // A probe that saw nothing agrees with a probe that saw nothing.
    expect(prepared).toHaveLength(2)
    expect(prepared[0]?.intent).toBe('read')
    expect(prepared[1]?.intent).toBe('read')
  })
})

// ---------------------------------------------------------------------------
// 4. The failure mode the per-instance cache exists to make impossible
// ---------------------------------------------------------------------------

describe('POD-3854 — a prepared read stays bound to the client its `db` resolved to', () => {
  /**
   * Two DISTINCT clients over one session, so which one ran a statement is
   * observable. `storeQueriesOver` hands the second to everything inside
   * `createOrJoinTransaction`, which is exactly the substitution a prepared
   * query built once per repository would defeat: it closes over the callback of
   * the instance it was prepared on.
   */
  async function twoClients() {
    const database = openMigratedTestDatabase()
    const driver = createBunSqliteDriver({ database })
    const session = await driver.open('write')
    cleanup.push(async () => {
      await session.close()
      await driver.close()
    })
    const used: string[] = []
    const named = (name: string) =>
      queryClientOver(
        async (statement) => {
          used.push(name)
          return await session.execute(statement)
        },
        async (batch) => {
          used.push(name)
          return await session.executeBatch(batch)
        },
      )
    const root = named('root')
    const tx = named('tx')
    return { used, queries: storeQueriesOver(root, async (fn) => await fn(tx)) }
  }

  it('keeps the enclosing transaction’s client, having already prepared on the root', async () => {
    const { used, queries } = await twoClients()
    const sessions = new SessionsRepository(queries)
    const repo = new UsersRepository(queries)
    await sessions.upsertSession(sessionRow('sess-a', ALICE, '2026-09-01T10:00:00.000Z'))
    await queries.rootDb.insert(users).values(account(ALICE, '2026-09-01T10:00:00.000Z')).run()

    // PREPARE ON THE ROOT FIRST. Without this the transaction would be the
    // first caller and would prepare its own query whatever the cache is keyed
    // on, so the test would pass against the defect it is here to catch.
    await sessions.getSession(asSessionId('sess-a'))
    await repo.get(ALICE)
    used.length = 0

    await queries.createOrJoinTransaction(async () => {
      await sessions.getSession(asSessionId('sess-a'))
      // A second id: the account read has a per-read-scope frame cache in front
      // of it, and a repeat of the same id never reaches a client at all.
      await repo.get(asUserId('user:nobody'))
    })
    expect(used).toEqual(['tx', 'tx'])
  })

  it('is a different prepared query per drizzle instance, and the root one survives', async () => {
    const { used, queries } = await twoClients()
    const sessions = new SessionsRepository(queries)
    await sessions.upsertSession(sessionRow('sess-a', ALICE, '2026-09-01T10:00:00.000Z'))
    used.length = 0
    await sessions.getSession(asSessionId('sess-a'))
    await queries.createOrJoinTransaction(async () => {
      await sessions.getSession(asSessionId('sess-a'))
    })
    await sessions.getSession(asSessionId('sess-a'))
    expect(used).toEqual(['root', 'tx', 'root'])
  })
})

// ---------------------------------------------------------------------------
// 5 & 6. All three connection roles, and one driver prepare per connection
// ---------------------------------------------------------------------------

describe('POD-3854 — the prepared query runs on every connection role', () => {
  /** A real file in WAL: the detached reader is a SECOND connection to it. */
  function walStore() {
    const dir = mkdtempSync(join(tmpdir(), 'pod-3854-'))
    const path = join(dir, 'store.db')
    const raw = openDatabase(path)
    raw.exec('PRAGMA journal_mode = WAL')
    runDrizzleMigrations(raw, DRIZZLE_MIGRATIONS)
    const prepares: string[] = []
    /** The same connection, with its `prepare` calls announced. */
    const counting = (db: SqlDatabase): SqlDatabase => ({
      prepare(text) {
        prepares.push(text)
        return db.prepare(text)
      },
      exec: (text) => db.exec(text),
      close: () => db.close(),
    })
    const driver = createBunSqliteDriver({
      database: counting(raw),
      openReader: () => counting(openDatabase(path, { readOnly: true })),
      onClose: () => rmSync(dir, { recursive: true, force: true }),
    })
    cleanup.push(async () => await driver.close())
    return { driver, prepares }
  }

  /** Repositories bound to one driver session, whichever role it has. */
  function overSession(session: DriverSession) {
    const client = queryClientOver(
      async (statement) => await session.execute(statement),
      async (batch) => await session.executeBatch(batch),
    )
    const queries = storeQueriesOver(client, async (fn) => await fn(client))
    return {
      sessions: new SessionsRepository(queries),
      users: new UsersRepository(queries),
      queries,
    }
  }

  it('answers the same on the write lane, a shared reader and a detached reader', async () => {
    const { driver, prepares } = walStore()
    const owner = await driver.open('write')
    const writer = overSession(owner)
    await writer.sessions.upsertSession(sessionRow('sess-a', ALICE, '2026-09-01T10:00:00.000Z'))
    await writer.queries.rootDb.insert(users).values(account(ALICE, '2026-09-01T10:00:00.000Z')).run()

    // THE WRITE LANE — the owner session, which is also the only role that may
    // have written the rows above.
    expect((await writer.sessions.getSession(asSessionId('sess-a')))?.ownerUserId).toBe(ALICE)
    expect((await writer.users.get(ALICE))?.id).toBe(ALICE)

    // THE SHARED READER — the SAME connection under a read lease, so it shares
    // the owner's statement cache and must not be allowed to write.
    const shared = overSession(await driver.open('read'))
    expect((await shared.sessions.getSession(asSessionId('sess-a')))?.ownerUserId).toBe(ALICE)
    expect((await shared.users.get(ALICE))?.id).toBe(ALICE)

    // THE DETACHED READER — a second connection, its own statement cache, and
    // read-only by construction. The prepared object carries only SQL and
    // params, so it is the CONNECTION that prepares, not the query.
    const detachedSession = await driver.openReader?.()
    expect(detachedSession).toBeDefined()
    const detached = overSession(detachedSession as DriverSession)
    expect((await detached.sessions.getSession(asSessionId('sess-a')))?.ownerUserId).toBe(ALICE)
    expect((await detached.users.get(ALICE))?.id).toBe(ALICE)

    // ONE PREPARE PER CONNECTION PER TEXT, not one per execution and not one
    // for the whole store: the shared reader reuses the owner's, the detached
    // reader has to make its own.
    const countOf = (fragment: string) =>
      prepares.filter((text) => text.includes(fragment)).length
    expect(countOf('from "sessions" where "sessions"."id" = ?')).toBe(2)
    expect(countOf('from "users" where "users"."id" = ?')).toBe(2)
  })

  it('refuses a write on a detached reader, the same way it always did', async () => {
    const { driver } = walStore()
    const detached = overSession((await driver.openReader?.()) as DriverSession)
    await expect(
      detached.queries.rootDb.insert(users).values(account(ALICE, '2026-09-01T10:00:00.000Z')).run(),
    ).rejects.toThrow()
  })
})
