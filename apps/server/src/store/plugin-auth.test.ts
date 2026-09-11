import { asUserId, firstAdminMemberId } from '@podium/model'
import { beforeEach, afterEach, expect, test } from 'vitest'
import { createPluginAuth } from '../plugin-auth'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
let store: SessionStore
beforeEach(async () => {
  store = await openTestStore(':memory:')
})
afterEach(async () => {
  await store.close()
})

test('creates account members with roles and profiles without local credentials', async () => {
  const auth = createPluginAuth(store.users)
  for (const role of ['admin', 'member'] as const) {
    const member = await auth.createMemberForAccount(
      `acct_${role}`,
      role,
      'Anna',
      'https://example.com/a.png',
    )
    expect(member.id).toMatch(/^mem_/)
    expect(await auth.findMemberByAccount(`acct_${role}`)).toMatchObject({
      id: member.id,
      role,
      displayName: 'Anna',
      avatar: 'https://example.com/a.png',
    })
    expect(await store.users.credentialFor(asUserId(member.id))).toBeUndefined()
    await auth.writeProfile(member.id, 'Anne', null)
    expect(await auth.findMemberByAccount(`acct_${role}`)).toMatchObject({
      displayName: 'Anne',
      avatar: null,
    })
  }
  expect(await auth.findMemberByAccount('missing')).toBeUndefined()
})
test('claims the existing member without changing its id or role and refuses reassignment', async () => {
  const auth = createPluginAuth(store.users)
  const id = firstAdminMemberId()
  expect(await auth.claimMemberForAccount(id, 'acct_owner')).toMatchObject({
    id,
    role: 'admin',
    accountId: 'acct_owner',
  })
  await expect(auth.claimMemberForAccount(id, 'acct_other')).rejects.toThrow()
  await expect(
    auth.createMemberForAccount('acct_owner', 'member', 'Duplicate', null),
  ).rejects.toThrow()
  expect(await store.users.list()).toHaveLength(1)
  await expect(auth.createMemberForAccount('', 'member', 'Blank', null)).rejects.toThrow()
  await expect(auth.writeProfile('missing', 'No one', null)).rejects.toThrow()
})

test('offers the earliest admin, and says whether it is still unclaimed', async () => {
  const auth = createPluginAuth(store.users)
  const before = await auth.earliestAdminMember()
  expect(before).toMatchObject({ role: 'admin', disabledAt: null })
  // accountId absent is the whole signal: a hosted owner may adopt THIS member
  // rather than minting a second one. Once it is set the member belongs to
  // somebody, and a later sign-in must create instead of claiming.
  expect(before?.accountId ?? null).toBeNull()

  await auth.claimMemberForAccount(before!.id, 'acct_owner')

  const after = await auth.earliestAdminMember()
  expect(after?.id).toBe(before!.id)
  expect(after?.accountId).toBe('acct_owner')
})
