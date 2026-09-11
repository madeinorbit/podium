import { asUserId, firstAdminMemberId, InviteId } from '@podium/model'
import { verifyPasswordHash } from '@podium/runtime/auth-store'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MemberInvites } from '../member-invites'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

let store: SessionStore
let invites: MemberInvites
let now: number
beforeEach(async () => {
  store = await openTestStore(':memory:')
  now = Date.parse('2026-09-11T12:00:00.000Z')
  invites = new MemberInvites(store.users, () => now)
})
afterEach(async () => {
  await store.close()
})
const passwordIdentity = {
  kind: 'password' as const,
  password: 'a secure password',
  email: 'anna@example.com',
  displayName: 'Anna',
}
const create = (input: Parameters<MemberInvites['create']>[1] = {}) =>
  invites.create(firstAdminMemberId(), input)

describe('member invitations', () => {
  test('creates a hashed, branded invitation and completes it with a password exactly once', async () => {
    const invite = await create({ email: ' Anna@EXAMPLE.com ' })
    expect(InviteId.safeParse(invite.id).success).toBe(true)
    const stored = (await store.users.pendingInvites())[0]!
    expect(stored.tokenHash).not.toBe(invite.token)
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(await invites.list(firstAdminMemberId()))).not.toContain(stored.tokenHash)
    const member = await invites.complete({ token: invite.token, identity: passwordIdentity })
    expect(member).toMatchObject({ displayName: 'Anna', email: 'anna@example.com', role: 'member' })
    expect(member.id).toMatch(/^mem_/)
    const credential = await store.users.credentialFor(asUserId(member.id))
    expect(await verifyPasswordHash(passwordIdentity.password, credential!.passwordHash!)).toBe(
      true,
    )
    await expect(
      invites.complete({ token: invite.token, identity: passwordIdentity }),
    ).rejects.toThrow()
    expect((await store.users.list()).length).toBe(2)
  })
  test('links an account to a new member without minting a password', async () => {
    const invite = await create({ role: 'admin', email: 'anna@example.com' })
    const member = await invites.complete({
      token: invite.token,
      identity: { kind: 'account', accountId: 'acct_anna', displayName: 'Anna' },
    })
    expect(member).toMatchObject({
      role: 'admin',
      accountId: 'acct_anna',
      email: 'anna@example.com',
    })
    expect(await store.users.credentialFor(asUserId(member.id))).toBeUndefined()
    await expect(
      invites.complete({
        token: invite.token,
        identity: { kind: 'account', accountId: 'acct_other' },
      }),
    ).rejects.toThrow()
  })
  test('claims an existing member and preserves its id and role', async () => {
    const invite = await create({ memberId: firstAdminMemberId(), role: 'member' })
    const member = await invites.complete({ token: invite.token, identity: passwordIdentity })
    expect(member.id).toBe(firstAdminMemberId())
    expect(member.role).toBe('admin')
    expect(member.email).toBe(passwordIdentity.email)
  })
  test('supports a trusted tokenless account claim, but refuses reassignment', async () => {
    const claim = {
      preAuthorizedMemberId: firstAdminMemberId(),
      identity: { kind: 'account' as const, accountId: 'acct_owner' },
    }
    expect((await invites.complete(claim)).id).toBe(firstAdminMemberId())
    await expect(
      invites.complete({ ...claim, identity: { kind: 'account', accountId: 'acct_attacker' } }),
    ).rejects.toThrow()
    expect((await store.users.get(firstAdminMemberId()))?.accountId).toBe('acct_owner')
  })
  test('expired, revoked and unknown invites never create a member', async () => {
    const expired = await create({ expiresInDays: 1 })
    now += 86_400_000
    await expect(
      invites.complete({ token: expired.token, identity: passwordIdentity }),
    ).rejects.toThrow()
    const revoked = await create()
    await invites.revoke(firstAdminMemberId(), revoked.id)
    await expect(
      invites.complete({ token: revoked.token, identity: passwordIdentity }),
    ).rejects.toThrow()
    await expect(
      invites.complete({ token: 'unknown', identity: passwordIdentity }),
    ).rejects.toThrow()
    expect((await store.users.list()).length).toBe(1)
  })
  test('only admins create and revoke; bound email cannot be changed', async () => {
    const invite = await create({ email: 'anna@example.com' })
    await expect(
      invites.complete({
        token: invite.token,
        identity: { ...passwordIdentity, email: 'other@example.com' },
      }),
    ).rejects.toThrow()
    const member = await invites.complete({ token: invite.token, identity: passwordIdentity })
    await expect(invites.create(asUserId(member.id), {})).rejects.toThrow('Administrator')
    const pending = await create()
    await expect(invites.revoke(asUserId(member.id), pending.id)).rejects.toThrow('Administrator')
    expect(await invites.inspect(pending.token)).toBeDefined()
  })
  test('concurrent completion admits exactly one claimant', async () => {
    const invite = await create()
    const results = await Promise.allSettled(
      [1, 2].map(() => invites.complete({ token: invite.token, identity: passwordIdentity })),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await store.users.list()).length).toBe(2)
  })
  test('duplicate account rolls back new member creation and keeps the invite usable', async () => {
    await invites.complete({
      preAuthorizedMemberId: firstAdminMemberId(),
      identity: { kind: 'account', accountId: 'acct_owner' },
    })
    const invite = await create()
    await expect(
      invites.complete({
        token: invite.token,
        identity: { kind: 'account', accountId: 'acct_owner' },
      }),
    ).rejects.toThrow()
    expect((await store.users.list()).length).toBe(1)
    expect(
      (
        await invites.complete({
          token: invite.token,
          identity: { kind: 'account', accountId: 'acct_new' },
        })
      ).accountId,
    ).toBe('acct_new')
  })
  test('remove disables access, deletes credentials sessions and pending invites, and protects self-removal', async () => {
    const invite = await create()
    const member = await invites.complete({ token: invite.token, identity: passwordIdentity })
    const id = asUserId(member.id)
    const pending = await create({ memberId: id })
    await store.auth.createClientSession('hash', id, '2099-01-01T00:00:00.000Z')
    await expect(
      store.users.removeMember(firstAdminMemberId(), firstAdminMemberId()),
    ).rejects.toThrow()
    await expect(store.users.removeMember(firstAdminMemberId(), id)).rejects.toThrow()
    await store.users.removeMember(id, firstAdminMemberId())
    expect(await store.users.get(id)).toBeUndefined()
    expect(await store.auth.getClientSession('hash')).toBeUndefined()
    await expect(invites.inspect(pending.token)).rejects.toThrow()
  })
})
