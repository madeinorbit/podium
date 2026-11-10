import { identityInvitation } from '@podium/identity/schema/sqlite'
import { asUserId, firstAdminMemberId } from '@podium/model'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { memberLinks } from '../member-invites'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { openTestIdentity, type TestIdentity } from '../test-support/test-identity'

let store: SessionStore
let identity: TestIdentity
beforeEach(async () => {
  store = await openTestStore(':memory:')
  identity = await openTestIdentity(store)
})
afterEach(async () => {
  vi.useRealTimers()
  await store.close()
})
const person = { password: 'a secure password', email: 'anna@example.com', displayName: 'Anna' }
const actor = () => ({ memberId: firstAdminMemberId() })
const create = (input = {}) =>
  identity.workspace.memberships.invite({ actor: actor(), role: 'member', ...input })
const links = () => memberLinks({ identity: identity.workspace, users: store.users })

describe('member invitations on shared identity', () => {
  test('creates a hashed invitation and completes it with a password exactly once', async () => {
    const { invitation, membership } = await create({ email: ' Anna@EXAMPLE.com ' })
    const database = store.identityDatabase()
    if (database.dialect !== 'sqlite') throw new Error('expected the SQLite test store')
    const [stored] = await database.db
      .select({ token_hash: identityInvitation.tokenHash })
      .from(identityInvitation)
      .where(eq(identityInvitation.id, invitation.id))
    expect(stored?.token_hash).not.toBe(invitation.token)
    expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(await identity.workspace.memberships.list())).not.toContain(
      stored?.token_hash,
    )
    const member = await links().complete({ token: invitation.token, ...person })
    expect(member.userId).toBe(membership.memberId)
    expect(await store.users.byEmail(person.email)).toMatchObject({
      id: member.userId,
      displayName: 'Anna',
    })
    expect(
      await identity.credentials.verifyPassword(asUserId(member.userId), person.password),
    ).toBe(true)
    await expect(links().complete({ token: invitation.token, ...person })).rejects.toThrow()
    expect(await store.users.list()).toHaveLength(2)
  })
  test('links an existing account to a new member without minting a password', async () => {
    const { invitation } = await create({ role: 'admin', email: person.email })
    const account = await identity.workspace.core.accounts.create({
      name: 'Anna',
      email: person.email,
    })
    const member = await identity.workspace.memberships.accept({
      token: invitation.token,
      account: { kind: 'existing', accountId: account.id },
    })
    expect(await store.users.byEmail(person.email)).toMatchObject({
      id: member.memberId,
      role: 'admin',
      accountId: account.id,
    })
    expect(await identity.workspace.core.accounts.hasPassword(account.id)).toBe(false)
    await expect(
      identity.workspace.memberships.accept({
        token: invitation.token,
        account: { kind: 'existing', accountId: account.id },
      }),
    ).rejects.toThrow()
  })
  test('reinviting a removed member preserves its id and chosen role', async () => {
    const bob = await identity.addMember({
      name: 'Anna',
      email: person.email,
      password: person.password,
    })
    await identity.workspace.memberships.remove({ actor: actor(), memberId: bob })
    const { invitation } = await create({ memberId: bob, role: 'admin' })
    expect((await links().complete({ token: invitation.token, ...person })).userId).toBe(bob)
    expect(await store.users.get(bob)).toMatchObject({ role: 'admin', email: person.email })
  })
  test('a tokenless account claim is refused and cannot reassign a member', async () => {
    const before = await store.users.get(firstAdminMemberId())
    await expect(links().complete({ token: '', ...person })).rejects.toThrow()
    expect((await store.users.get(firstAdminMemberId()))?.accountId).toBe(before?.accountId)
  })
  test('expired, revoked and unknown invites never create a member', async () => {
    const { invitation: expired } = await create({ expiresInDays: 1 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 86_400_001)
    await expect(links().complete({ token: expired.token, ...person })).rejects.toThrow()
    vi.useRealTimers()
    const { invitation } = await create()
    await identity.workspace.memberships.revokeInvitation({
      actor: actor(),
      invitationId: invitation.id,
    })
    await expect(links().complete({ token: invitation.token, ...person })).rejects.toThrow()
    await expect(links().complete({ token: 'unknown', ...person })).rejects.toThrow()
    expect(await store.users.list()).toHaveLength(1)
  })
  test('only admins create and revoke; bound email cannot be changed', async () => {
    const { invitation } = await create({ email: person.email })
    await expect(
      links().complete({ token: invitation.token, ...person, email: 'other@example.com' }),
    ).rejects.toThrow()
    const bob = await links().complete({ token: invitation.token, ...person })
    await expect(
      identity.workspace.memberships.invite({ actor: { memberId: bob.userId }, role: 'member' }),
    ).rejects.toMatchObject({ code: 'admin-required' })
    const pending = await create()
    await expect(
      identity.workspace.memberships.revokeInvitation({
        actor: { memberId: bob.userId },
        invitationId: pending.invitation.id,
      }),
    ).rejects.toMatchObject({ code: 'admin-required' })
    expect(await links().inspect(pending.invitation.token)).toBeDefined()
  })
  test('concurrent completion admits exactly one claimant', async () => {
    const { invitation } = await create()
    const results = await Promise.allSettled(
      [1, 2].map(() => links().complete({ token: invitation.token, ...person })),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await store.users.list()).toHaveLength(2)
  })
  test('duplicate account rolls back member creation and keeps the invite usable', async () => {
    const accountId = (await store.users.get(firstAdminMemberId()))!.accountId!
    const { invitation } = await create()
    await expect(
      identity.workspace.memberships.accept({
        token: invitation.token,
        account: { kind: 'existing', accountId },
      }),
    ).rejects.toMatchObject({ code: 'already-a-member' })
    expect(await store.users.list()).toHaveLength(1)
    expect((await links().complete({ token: invitation.token, ...person })).userId).toBeTruthy()
  })
  test('remove ends credentials, sign-ins and reset codes, and protects the last admin', async () => {
    const bob = await identity.addMember({
      name: 'Anna',
      email: person.email,
      password: person.password,
    })
    const signed = await identity.signIn({ email: person.email, password: person.password })
    const reset = await links().createRecovery(firstAdminMemberId(), bob)
    await expect(
      identity.workspace.memberships.remove({ actor: actor(), memberId: firstAdminMemberId() }),
    ).rejects.toMatchObject({ code: 'last-admin' })
    await expect(
      identity.workspace.memberships.remove({
        actor: { memberId: bob },
        memberId: firstAdminMemberId(),
      }),
    ).rejects.toMatchObject({ code: 'admin-required' })
    await identity.workspace.memberships.remove({ actor: actor(), memberId: bob })
    expect(await store.users.get(bob)).toBeUndefined()
    expect(await identity.workspace.core.accounts.get(signed.accountId)).toBeUndefined()
    expect(await identity.workspace.core.deviceSignIns.listForAccount(signed.accountId)).toEqual([])
    await expect(links().inspect(reset.token)).rejects.toThrow()
  })
})
