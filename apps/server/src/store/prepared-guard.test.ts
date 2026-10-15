/**
 * EVERY REPOSITORY QUERY IS BUILT ONCE [POD-6147, server data design §3 rule 1].
 *
 * A drizzle builder chain does its expensive work at the terminal: it
 * serialises the SQL and generates a row mapper. POD-3854 measured that as
 * about 89% of a primary-key read. The repositories in `apps/server/src/store`
 * and `packages/sync/src/adapters/sqlite` therefore define each query once,
 * with `prepared(...)` or `preparedFamily(...)`, and a method only fills
 * placeholders and runs it.
 *
 * TWO HALVES, because each sees what the other cannot:
 *
 *   - THE CENSUS reads the source. A builder that starts on a drizzle handle
 *     outside a definition runs on every call, whether or not any test calls
 *     that method. It recognises a handle by name (`db`, `tx`, `rootDb`,
 *     `*.db`), which is the uniform convention in the covered files.
 *   - THE RUNTIME COUNT reads the drizzle session's own preparation counter
 *     (`preparationsOf`), so it catches a builder behind a renamed handle that
 *     the census would miss, and it is what shows a query prepared once stays
 *     prepared ACROSS transactions: the store hands out one drizzle instance,
 *     and the executor routes each statement to the current transaction when it
 *     runs.
 */

import { asMachineId, asSessionId, asUserId, type UserId } from '@podium/model'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { users } from '../migrations/schema'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { openTestStore } from '../test-support/open-test-store'
import { censusScope, perCallBuilders } from '../test-support/prepared-census'
import { createBunStoreExecutor, probeStatements, type StatementObservation } from './executor'
import { preparationsOf } from './executor/sync-drizzle'
import { GrantsRepository } from './grants'
import { MachinesRepository } from './machines'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'
import { UsersRepository } from './users'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

/**
 * THE ALLOWLIST: `file:Class.member` of every builder the census accepts, each
 * with the reason it cannot be prepared once. An entry is a decision, so a new
 * per-call builder fails this test until someone writes one here.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([])

function trackedSources(): string[] {
  const out: string[] = []
  for (const dir of ['apps/server/src/store', 'packages/sync/src/adapters/sqlite']) {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { recursive: true })) {
      out.push(relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry))))
    }
  }
  return censusScope(out.map((path) => path.split('\\').join('/')))
}

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function migratedStore() {
  const database = openMigratedTestDatabase()
  const queries = createBunStoreExecutor({ database }).queries
  cleanup.push(() => database.close())
  return { database, queries }
}

const ALICE = asUserId('user:alice')

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

// ---------------------------------------------------------------------------
// 1. The census
// ---------------------------------------------------------------------------

describe('POD-6147 — no repository builds a query per call', () => {
  it('finds no per-call builder outside the allowlist', () => {
    const files = trackedSources()
    // A census that read nothing would pass; the covered set is dozens of files.
    expect(files.length).toBeGreaterThan(40)
    const found = files.flatMap((file) =>
      perCallBuilders(file, readFileSync(join(REPO_ROOT, file), 'utf8')),
    )
    const unexplained = found
      .filter((builder) => !ALLOWLIST.has(`${builder.file}:${builder.member}`))
      .map((builder) => `${builder.file}:${builder.line} ${builder.member} .${builder.method}()`)
    expect(unexplained).toEqual([])
    // An allowlist entry whose builder is gone is a stale exemption.
    const live = new Set(found.map((builder) => `${builder.file}:${builder.member}`))
    expect([...ALLOWLIST.keys()].filter((key) => !live.has(key))).toEqual([])
  })

  it('is armed: it reports a planted per-call builder and accepts the prepared form', () => {
    const planted = `
      import { prepared } from './executor/sync-drizzle'
      const byId = prepared((db) => db.select().from(t).where(eq(t.id, param(t.id, 'id'))).prepare())
      function shared(db, where) { return db.select().from(t).where(where).prepare() }
      const viaHelper = prepared((db) => shared(db, undefined))
      export class Repo {
        get db() { return this.rootDb }
        async fluent(id) { return await this.db.select().from(t).where(eq(t.id, id)).get() }
        async raw() { return await this.db.all(sql\`select 1\`) }
        async kept(id) { return await byId(this.db).get({ id }) }
        perCallHelper(db) { return shared(db, undefined) }
      }`
    const found = perCallBuilders('planted.ts', planted).map(
      (builder) => `${builder.member}.${builder.method}`,
    )
    // `shared` is called from a method too, so it is no longer a definition helper.
    expect(found).toEqual(['shared.select', 'Repo.fluent.select', 'Repo.raw.all'])
  })
})

// ---------------------------------------------------------------------------
// 2. One preparation, however many calls and transactions
// ---------------------------------------------------------------------------

describe('POD-6147 — a prepared query is reused inside and outside transactions', () => {
  it('prepares the hot reads once across calls and across several transactions', async () => {
    const { queries } = migratedStore()
    const sessions = new SessionsRepository(queries)
    const usersRepo = new UsersRepository(queries)
    const machines = new MachinesRepository(queries)
    const grants = new GrantsRepository(queries)
    const db = queries.rootDb
    await sessions.upsertSession(sessionRow('sess-a', ALICE, '2026-09-01T10:00:00.000Z'))
    await db.insert(users).values(account(ALICE, '2026-09-01T10:00:00.000Z')).run()

    let n = 0
    const readAll = async () => {
      n += 1
      // A new id each round: the account read has a per-read-scope frame cache,
      // and a repeated id would never reach the query at all.
      await usersRepo.get(asUserId(`user:nobody-${n}`))
      await sessions.getSession(asSessionId('sess-a'))
      await sessions.getSessions(['sess-a', `sess-missing-${n}`])
      await machines.getMachine(`machine-${n}`)
      await grants.listForResource('machine', `machine-${n}`)
    }

    await readAll() // the warm-up prepares each query once
    const warmed = preparationsOf(db)
    await readAll()
    await readAll()
    for (let round = 0; round < 3; round++) {
      await queries.createOrJoinTransaction(async () => {
        await readAll()
      })
    }
    expect(preparationsOf(db)).toBe(warmed)
  })

  it('counts a per-call builder, so the flat count above is not vacuous', async () => {
    const { queries } = migratedStore()
    const db = queries.rootDb
    const before = preparationsOf(db)
    await db.select().from(users).all()
    await db.select().from(users).all()
    expect(preparationsOf(db) - before).toBe(2)
  })

  it('runs a query prepared at the root inside the enclosing transaction', async () => {
    const { queries } = migratedStore()
    const sessions = new SessionsRepository(queries)
    // PREPARE AT THE ROOT FIRST, so the transaction reuses the root's query
    // rather than preparing its own.
    expect(await sessions.getSession(asSessionId('sess-a'))).toBeUndefined()
    const prepared = preparationsOf(queries.rootDb)

    await expect(
      queries.createOrJoinTransaction(async () => {
        await sessions.upsertSession(sessionRow('sess-a', ALICE, '2026-09-01T10:00:00.000Z'))
        // The transaction's own uncommitted write is visible: the read ran on
        // the transaction's connection, inside its BEGIN.
        expect((await sessions.getSession(asSessionId('sess-a')))?.id).toBe('sess-a')
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')

    // And the rollback took it away, so the write ran inside the transaction too.
    expect(await sessions.getSession(asSessionId('sess-a'))).toBeUndefined()
    // The upsert prepared once (it had not run before); the read did not again.
    expect(preparationsOf(queries.rootDb) - prepared).toBe(1)
  })

  it('reuses the issue read across transactions on the store the server builds', async () => {
    const store = await openTestStore(':memory:')
    cleanup.push(async () => await store.close())
    const queries = (store as unknown as { queries: { rootDb: Parameters<typeof preparationsOf>[0] } })
      .queries
    const transact = (store as unknown as {
      queries: { createOrJoinTransaction: <T>(fn: () => Promise<T>) => Promise<T> }
    }).queries.createOrJoinTransaction
    await store.issues.getIssue('missing-0')
    const warmed = preparationsOf(queries.rootDb)
    for (let round = 1; round <= 3; round++) {
      await store.issues.getIssue(`missing-${round}`)
      await transact(async () => {
        await store.issues.getIssue(`missing-tx-${round}`)
      })
    }
    expect(preparationsOf(queries.rootDb)).toBe(warmed)
  })
})

// ---------------------------------------------------------------------------
// 3. Bounded IN lists
// ---------------------------------------------------------------------------

describe('POD-6147 — IN-list statements are bounded', () => {
  it('keeps the number of distinct SQL texts flat as list lengths grow', async () => {
    const { database, queries } = migratedStore()
    const sessions = new SessionsRepository(queries)
    await sessions.upsertSession(sessionRow('sess-a', ALICE, '2026-09-01T10:00:00.000Z'))
    const seen: StatementObservation[] = []
    cleanup.push(probeStatements({ db: database }, (observation) => seen.push(observation)))

    const textsFor = async (lengths: readonly number[]) => {
      seen.length = 0
      for (const length of lengths) {
        const ids = ['sess-a', ...Array.from({ length: length - 1 }, (_, i) => `sess-${length}-${i}`)]
        const found = await sessions.getSessions(ids)
        // Padding repeats a value; the answer is the exact list's answer.
        expect([...found.keys()]).toEqual(['sess-a'])
      }
      return new Set(seen.map((observation) => observation.sql)).size
    }

    // Every length from 1 to 600 (600 crosses the 500-value chunk).
    const all = Array.from({ length: 600 }, (_, i) => i + 1)
    const distinct = await textsFor(all)
    // 1, 2, 4, ..., 512 — ten shapes — where the fluent form made one per
    // distinct length (500 of them here).
    expect(distinct).toBeLessThanOrEqual(10)
    // And half the lengths make as many texts: the count does not follow them.
    expect(await textsFor(all.slice(0, 300))).toBe(distinct)
  })
})
