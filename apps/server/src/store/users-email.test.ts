import { asUserId, firstAdminMemberId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

let store: SessionStore
beforeEach(async () => {
  store = await openTestStore(':memory:')
})
afterEach(async () => {
  await store.close()
})

const member = (id: string, email?: string | null) => ({
  id,
  displayName: id,
  email,
  role: 'member' as const,
  createdAt: '2026-09-11T00:00:00.000Z',
  disabledAt: null,
})

describe('member email storage', () => {
  test('multiple members can have null email; addresses normalize and are unique on create and update', async () => {
    await store.users.create(member('user:a'), 'hash')
    await store.users.create(member('user:b', null), 'hash')
    expect((await store.users.get(asUserId('user:a')))?.email).toBeNull()
    await store.users.setEmail(asUserId('user:a'), ' Alice@EXAMPLE.com ')
    expect((await store.users.byEmail('ALICE@example.com'))?.id).toBe('user:a')
    await expect(
      store.users.create(member('user:c', 'alice@example.com'), 'hash'),
    ).rejects.toThrow()
    expect(await store.users.get(asUserId('user:c'))).toBeUndefined()
    await expect(store.users.setEmail(asUserId('user:b'), 'ALICE@example.com')).rejects.toThrow()
    expect((await store.users.get(asUserId('user:b')))?.email).toBeNull()
    await store.users.setEmail(asUserId('user:a'), 'next@example.com')
    expect(await store.users.byEmail('alice@example.com')).toBeUndefined()
    await store.users.setEmail(asUserId('user:b'), 'alice@example.com')
    expect((await store.users.byEmail('alice@example.com'))?.id).toBe('user:b')
  })

  test('invalid email writes are refused without changing the member', async () => {
    await expect(store.users.setEmail(firstAdminMemberId(), '')).rejects.toThrow()
    await expect(store.users.setEmail(firstAdminMemberId(), 'user:sole')).rejects.toThrow()
    expect((await store.users.get(firstAdminMemberId()))?.email).toBeNull()
  })
})
