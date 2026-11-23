import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMembership, type MembershipSnapshot } from '@podium/identity'
import { asUserId, firstAdminMemberId, MemberId, type UserRole } from '@podium/model'
import { earliestAdminMember } from '@podium/runtime/earliest-admin'
import { openDatabase } from '@podium/runtime/sqlite'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { openTestStore } from '../test-support/open-test-store'
import { openPeopleStoreSlice, type PeopleStoreSlice } from '../test-support/people-store-slice'
import { testStoreEngine } from '../test-support/pg-test-database'

/** A member as these cases write one: its own creation time, then the member writer. */
interface Member {
  readonly id: string
  readonly displayName: string
  readonly role: UserRole
  readonly createdAt: string
  readonly disabledAt: string | null
}

/**
 * The member facts these cases need, over the two-engine slice: the row with its given
 * creation time first, then the one member writer, as `fixtures/test-support.ts`'s
 * `memberFacts` writes them over a whole store.
 */
function members(slice: PeopleStoreSlice) {
  async function write(id: string, change: Partial<MembershipSnapshot>) {
    const [stored] = await slice.all<{ version: number }>(
      sql`SELECT membership_version AS version FROM users WHERE id = ${id}`,
    )
    const version = Number(stored?.version ?? 0) + 1
    const row = await slice.users.get(asUserId(id))
    await slice.drained(async () => {
      await applyMembership(slice.users.memberRows, {
        memberId: id,
        version,
        authorizationVersion: 0,
        status: row?.disabledAt ? 'disabled' : 'active',
        role: row?.role ?? 'member',
        accountId: null,
        profile: { name: row?.displayName ?? 'Member', email: null, image: null },
        actor: { system: 'upgrade' },
        ...change,
      })
    })
  }
  return {
    async create(member: Member) {
      await slice.run(
        sql`INSERT INTO users (workspace_id, id, display_name, role, created_at) VALUES (${SELF_HOSTED_WORKSPACE_ID}, ${member.id}, ${member.displayName}, ${member.role}, ${member.createdAt})`,
      )
      await write(member.id, { role: member.role, status: 'active' })
      if (member.disabledAt) await write(member.id, { status: 'disabled' })
    },
    async disable(id: string) {
      await write(id, { status: 'disabled' })
    },
    async removeMember(id: string, actor: string) {
      await write(id, { status: 'removed', actor: { memberId: actor } })
    },
  }
}

/**
 * A store of the run's engine with its first administrator. The SQLite migration mints
 * one; the Postgres baseline holds no rows (a hosted workspace's first administrator is
 * provisioned), so there the fixture writes one, dated before every member below.
 */
async function storeWithFirstAdmin(): Promise<PeopleStoreSlice> {
  const slice = await openPeopleStoreSlice()
  if ((await slice.users.earliestAdmin()) === undefined) {
    await members(slice).create({
      id: 'mem_1FFFFFFFFFFFFFFFFFFFFFFFFFF',
      displayName: 'First admin',
      role: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabledAt: null,
    })
  }
  return slice
}

/** The SQLite migration and the CLI's raw SQLite handle; neither exists on Postgres. */
const sqliteOnly = it.skipIf(testStoreEngine() === 'pg')

describe('UsersRepository.earliestAdmin', () => {
  sqliteOnly('is the member the migration minted, through the boundary schema', async () => {
    const store = await openTestStore(':memory:')
    const first = await store.users.earliestAdmin()
    expect(first).toBeDefined()
    expect(() => MemberId.parse(first?.id)).not.toThrow()
    expect(first?.role).toBe('admin')
  })

  sqliteOnly('agrees with the SQL the CLI asks the same question with', async () => {
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
    const store = await storeWithFirstAdmin()
    try {
      const first = await store.users.earliestAdmin()
      expect(first?.role).toBe('admin')
      await members(store).create({
        id: 'mem_2YYYYYYYYYYYYYYYYYYYYYYYYYY',
        displayName: 'Anna',
        role: 'admin',
        createdAt: '2099-01-01T00:00:00.000Z',
        disabledAt: null,
      })
      expect((await store.users.earliestAdmin())?.id).toBe(first?.id)
    } finally {
      await store.close()
    }
  })

  it('does not answer with a member, however early, who is not an admin', async () => {
    const store = await storeWithFirstAdmin()
    try {
      await members(store).create({
        id: 'mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA',
        displayName: 'Anna',
        role: 'member',
        createdAt: '2000-01-01T00:00:00.000Z',
        disabledAt: null,
      })
      expect((await store.users.earliestAdmin())?.role).toBe('admin')
    } finally {
      await store.close()
    }
  })
})

describe('store scoped administrator identity', () => {
  it('follows removal immediately without changing another store', async () => {
    const a = await storeWithFirstAdmin()
    const b = await storeWithFirstAdmin()
    try {
      const original = await firstAdminMemberId(a)
      const other = MemberId.parse('mem_0ujzPyRiIAffKhBux4PvQdDqMHY')
      await members(b).create({
        id: other,
        displayName: 'Other installation',
        role: 'admin',
        createdAt: '2000-01-01T00:00:00.000Z',
        disabledAt: null,
      })
      expect(await firstAdminMemberId(b)).toBe(other)
      expect(await firstAdminMemberId(a)).toBe(original)
      const replacement = asUserId('mem_2YYYYYYYYYYYYYYYYYYYYYYYYYY')
      await members(a).create({
        id: replacement,
        displayName: 'Next admin',
        role: 'admin',
        createdAt: '2099-01-01T00:00:00.000Z',
        disabledAt: null,
      })
      await members(a).removeMember(original, replacement)
      expect(await a.users.get(original)).toBeUndefined()
      expect(await firstAdminMemberId(a)).toBe(replacement)
      expect((await a.users.earliestAdmin())?.id).toBe(replacement)
      expect(await firstAdminMemberId(b)).toBe(other)
    } finally {
      await a.close()
      await b.close()
    }
  })
})

describe('UsersRepository.activeAdminIds (POD-6358)', () => {
  it('is every admin who can act: no member, no disabled admin', async () => {
    const store = await storeWithFirstAdmin()
    try {
      const first = (await store.users.earliestAdmin())?.id
      const account = (id: string, role: 'admin' | 'member'): Member => ({
        id,
        displayName: id,
        role,
        createdAt: '2099-01-01T00:00:00.000Z',
        disabledAt: null,
      })
      const facts = members(store)
      await facts.create(account('mem_2AAAAAAAAAAAAAAAAAAAAAAAAAA', 'admin'))
      await facts.create(account('mem_2BBBBBBBBBBBBBBBBBBBBBBBBBB', 'member'))
      await facts.create(account('mem_2CCCCCCCCCCCCCCCCCCCCCCCCCC', 'admin'))
      await facts.disable('mem_2CCCCCCCCCCCCCCCCCCCCCCCCCC')
      expect([...(await store.users.activeAdminIds())].sort()).toEqual(
        [first, 'mem_2AAAAAAAAAAAAAAAAAAAAAAAAAA'].sort(),
      )
    } finally {
      await store.close()
    }
  })
})
