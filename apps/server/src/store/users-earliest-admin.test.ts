import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId, MemberId } from '@podium/model'
import { earliestAdminMember } from '@podium/runtime/earliest-admin'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { openTestStore } from '../test-support/open-test-store'

describe('UsersRepository.earliestAdmin', () => {
  it('is the member the migration minted, through the boundary schema', async () => {
    const store = await openTestStore(':memory:')
    const first = await store.users.earliestAdmin()
    expect(first).toBeDefined()
    expect(() => MemberId.parse(first?.id)).not.toThrow()
    expect(first?.role).toBe('admin')
  })

  it('agrees with the SQL the CLI asks the same question with', async () => {
    // THE TIE BETWEEN THE TWO SPELLINGS, and the reason it is behavioural rather
    // than textual. The repository builds the query with drizzle (rule 16
    // refuses splicing a constant through `sql.raw`), while the break-glass mint
    // runs `EARLIEST_ADMIN_MEMBER_SQL` on a raw handle. Two executors, one
    // question — so they are compared by ANSWER, against one database. A string
    // comparison would catch an edit to the constant and miss the thing that
    // actually bites: the two disagreeing about what they do with it.
    // A FILE, not `:memory:` — the raw handle has to open the same database,
    // and an in-memory one is private to the connection that made it.
    const path = join(mkdtempSync(join(tmpdir(), 'podium-earliest-admin-')), 'podium.db')
    const store = await openTestStore(path)
    const throughDrizzle = (await store.users.earliestAdmin())?.id
    const raw = openDatabase(path)
    const throughRawSql = earliestAdminMember(raw)
    raw.close?.()

    expect(throughDrizzle).toBeDefined()
    expect(throughRawSql).toBe(throughDrizzle)
    // Background consumers resolve the same active member from this store.
    expect(await firstAdminMemberId(store)).toBe(throughDrizzle)
  })

  it('prefers the earliest admin over one created later', async () => {
    const store = await openTestStore(':memory:')
    const first = await store.users.earliestAdmin()
    await store.users.create(
      {
        id: 'mem_2YYYYYYYYYYYYYYYYYYYYYYYYYY',
        displayName: 'Anna',
        role: 'admin',
        createdAt: '2099-01-01T00:00:00.000Z',
        disabledAt: null,
      },
      'scrypt:hash',
    )
    expect((await store.users.earliestAdmin())?.id).toBe(first?.id)
  })

  it('does not answer with a member, however early, who is not an admin', async () => {
    const store = await openTestStore(':memory:')
    await store.users.create(
      {
        id: 'mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA',
        displayName: 'Anna',
        role: 'member',
        createdAt: '2000-01-01T00:00:00.000Z',
        disabledAt: null,
      },
      'scrypt:hash',
    )
    expect((await store.users.earliestAdmin())?.role).toBe('admin')
  })
})

describe('store scoped administrator identity', () => {
  it('follows removal immediately without changing another store', async () => {
    const a = await openTestStore(':memory:')
    const original = await firstAdminMemberId(a)
    const b = await openTestStore(':memory:')
    const other = MemberId.parse('mem_0ujzPyRiIAffKhBux4PvQdDqMHY')
    await b.users.create({ id: other, displayName: 'Other installation', role: 'admin',
      createdAt: '2000-01-01T00:00:00.000Z', disabledAt: null }, 'scrypt:hash')
    expect(await firstAdminMemberId(b)).toBe(other)
    expect(await firstAdminMemberId(a)).toBe(original)
    const replacement = MemberId.parse('mem_2YYYYYYYYYYYYYYYYYYYYYYYYYY')
    await a.users.create({ id: replacement, displayName: 'Next admin', role: 'admin',
      createdAt: '2099-01-01T00:00:00.000Z', disabledAt: null }, 'scrypt:hash')
    await a.users.removeMember(original, replacement)
    expect(await a.users.get(original)).toBeUndefined()
    expect(await firstAdminMemberId(a)).toBe(replacement)
    expect((await a.users.earliestAdmin())?.id).toBe(replacement)
    expect(await firstAdminMemberId(b)).toBe(other)
    await a.close()
    await b.close()
  })
})
