/**
 * THE STORE'S HALF OF THE EARLIEST-ADMIN RULE (A2).
 *
 * `packages/runtime/src/earliest-admin.test.ts` pins the RULE — which member
 * wins, what a disabled admin does, what the two empty answers are. This pins
 * the two things only the store can answer: that the repository asking through
 * drizzle gets the same verdict as the CLI asking on a raw handle, and that
 * opening a store PRIMES `firstAdminMemberId()`, which is what every ambient
 * site in the server reads.
 *
 * The priming is worth a test of its own rather than being assumed from the
 * migrator's code, because nothing else would notice it stopping: the ambient
 * sites would throw at the first authorization check on a live server, and every
 * test that opens a store first would keep passing.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearFirstAdminMember, firstAdminMemberId, MemberId } from '@podium/model'
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
    // …and it is what opening the store primed for every ambient site.
    expect(firstAdminMemberId()).toBe(throughDrizzle)
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

describe('opening a store primes the first admin', () => {
  it('leaves `firstAdminMemberId()` answerable after an open', async () => {
    // Cleared first, so this asserts the OPEN did it rather than some earlier
    // test in the file having left a value behind.
    clearFirstAdminMember()
    expect(() => firstAdminMemberId()).toThrow(/not resolved/)

    const store = await openTestStore(':memory:')
    expect(() => MemberId.parse(firstAdminMemberId())).not.toThrow()
    expect(store).toBeDefined()
  })
})
