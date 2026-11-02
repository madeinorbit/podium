/**
 * The first declared cache, `users.earliest-admin` [POD-6150]: read once across
 * operations, never inside a save, and removed by every committed write of
 * `users`, so no read after a write can see the row from before it.
 */
import { asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { expectWriteEvicts } from '../test-support/cache'
import { openTestStore } from '../test-support/open-test-store'
import { countStatements } from '../test-support/statement-count'
import { declaredCaches } from './cache/cache'
import { withOperation } from './executor/operation-scope'
import type { StoreQueries } from './executor/sync-drizzle'
import { EARLIEST_ADMIN_CACHE, type UserAccountRow, UsersRepository } from './users'

const KEY = 'earliest-admin'
const LATER = asUserId('mem_2YYYYYYYYYYYYYYYYYYYYYYYYYY')

const account = (id: string, role: 'admin' | 'member', createdAt: string): UserAccountRow => ({
  id, displayName: id, email: null, role, createdAt, disabledAt: null,
})

describe('users.earliest-admin cache', () => {
  let store: SessionStore
  let first: UserAccountRow
  const earliest = async () => await withOperation(async () => await store.users.earliestAdmin())

  beforeEach(async () => {
    store = await openTestStore(':memory:')
    first = (await earliest())!
    await store.users.create(account(LATER, 'admin', '2099-01-01T00:00:00.000Z'), 'scrypt:hash')
  })
  afterEach(async () => {
    await store.close()
  })

  it('is declared, with its limit and invalidating table', () => {
    expect(declaredCaches()).toContain(EARLIEST_ADMIN_CACHE)
    expect(EARLIEST_ADMIN_CACHE).toMatchObject({ limit: 1, invalidatedBy: ['users'] })
  })

  it('reads the row once across operations', async () => {
    expect((await countStatements(store, earliest)).statements).toBe(1)
    expect((await countStatements(store, earliest)).statements).toBe(0)
    expect(await earliest()).toEqual(first)
  })

  it('reads the database inside a write span, even when the cache holds the row', async () => {
    await earliest()
    expect(await store.users.earliestAdminCache.get(KEY)).toEqual(first)
    await store.transact(async () => {
      const { result, statements } = await countStatements(store, async () => await store.users.earliestAdmin())
      expect(result).toEqual(first)
      expect(statements).toBe(1)
    })
  })

  describe('every write of users removes the entry', () => {
    const evicts = (): { evicts: [typeof KEY, UserAccountRow][] } => ({ evicts: [[KEY, first]] })

    it.each<[string, (store: SessionStore, admin: UserAccountRow) => Promise<unknown>]>([
      ['create', async (s) =>
        await s.users.create(account('mem_3ZZZZZZZZZZZZZZZZZZZZZZZZZZ', 'member', '2099-02-01T00:00:00.000Z'), 'h')],
      ['createUnclaimed', async (s) =>
        await s.users.createUnclaimed(account('mem_4ZZZZZZZZZZZZZZZZZZZZZZZZZZ', 'member', '2099-03-01T00:00:00.000Z'))],
      ['disable', async (s) => await s.users.disable(LATER, '2099-04-01T00:00:00.000Z')],
      ['setEmail', async (s, admin) => await s.users.setEmail(asUserId(admin.id), 'admin@example.com')],
      ['writeProfile', async (s, admin) => await s.users.writeProfile(asUserId(admin.id), 'Renamed', null)],
      ['attachAccount', async (s, admin) => await s.users.attachAccount(asUserId(admin.id), 'acct_1')],
      ['setPasswordHash', async (s, admin) =>
        await s.users.setPasswordHash(asUserId(admin.id), 'scrypt:other', '2099-05-01T00:00:00.000Z')],
      ['removeMember', async (s, admin) => await s.users.removeMember(LATER, asUserId(admin.id))],
    ])('%s', async (_, write) => {
      await expectWriteEvicts(store.users.earliestAdminCache, async () => await write(store, first), evicts())
    })

    it('enable', async () => {
      await store.users.disable(LATER, '2099-04-01T00:00:00.000Z')
      await expectWriteEvicts(
        store.users.earliestAdminCache,
        async () => await store.users.enable(LATER, '2099-04-02T00:00:00.000Z'),
        evicts(),
      )
    })
  })

  describe('no read after a write sees the row from before it', () => {
    it('a disabled earliest admin is replaced at once, and comes back when enabled', async () => {
      await earliest()
      await store.users.disable(asUserId(first.id), '2099-06-01T00:00:00.000Z')
      expect((await earliest())?.id).toBe(LATER)
      await store.users.enable(asUserId(first.id), '2099-06-02T00:00:00.000Z')
      expect((await earliest())?.id).toBe(first.id)
    })

    it('an earlier admin created later takes over at once', async () => {
      await earliest()
      const earlier = asUserId('mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA')
      await store.users.create(account(earlier, 'admin', '2000-01-01T00:00:00.000Z'), 'h')
      expect((await earliest())?.id).toBe(earlier)
    })

    it('a profile write of the admin is read back', async () => {
      await earliest()
      await store.users.writeProfile(asUserId(first.id), 'Renamed', 'avatar.png')
      expect(await earliest()).toMatchObject({ id: first.id, displayName: 'Renamed', avatar: 'avatar.png' })
    })

    it('a write through another repository of the same store removes it too', async () => {
      // `SuperagentRepository` holds a UsersRepository of its own.
      const queries = (store as unknown as { queries: StoreQueries }).queries
      const other = new UsersRepository(queries)
      expect((await withOperation(async () => await other.earliestAdmin()))?.id).toBe(first.id)
      await store.users.disable(asUserId(first.id), '2099-07-01T00:00:00.000Z')
      expect((await withOperation(async () => await other.earliestAdmin()))?.id).toBe(LATER)
      await other.enable(asUserId(first.id), '2099-07-02T00:00:00.000Z')
      expect((await earliest())?.id).toBe(first.id)
    })

    it('a write that rolls back leaves the cached row, which is still the database\'s', async () => {
      await earliest()
      await expect(store.transact(async () => {
        await store.users.writeProfile(asUserId(first.id), 'Rolled back', null)
        throw new Error('roll back')
      })).rejects.toThrow('roll back')
      expect((await countStatements(store, earliest)).statements).toBe(0)
      expect((await earliest())?.displayName).toBe(first.displayName)
    })
  })
})
