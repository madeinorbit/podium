import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability } from '@podium/model'
import { asUserId, firstAdminMemberId } from '@podium/model'
import { loadConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'

import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { openTestIdentity } from './test-support/test-identity'

/**
 * ONE registry per test on a REAL store with the identity a server builds on
 * it: `auth.*` writes the password and address of the caller's ACCOUNT, and a
 * fake would let the per-caller scoping pass without proving anything moved.
 * `loginRequired` is the package's answer, as server.ts composes it.
 */
async function harness(
  member = false,
  loginPolicy?: import('./modules/instance/service').InstanceLoginPolicy,
  hostLocalRequest = true,
) {
  const store = await openTestStore(':memory:')
  const identity = await openTestIdentity(store)
  const registry = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    memberCredentials: identity.credentials,
  })
  await attachHostDaemon(registry, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const users = registry.sessionStore.users
  const loginRequired = (): Promise<boolean> => identity.workspace.signInRequired()
  const memberId = member
    ? await identity.addMember({
        name: 'Member',
        email: 'first@example.com',
        password: 'member-password',
      })
    : asUserId('nobody')
  const capability: Capability = member
    ? {
        role: 'worker',
        scope: { kind: 'owned', userId: memberId },
        actorUser: memberId,
        onBehalfOf: memberId,
      }
    : OPERATOR
  const context = {
    registry,
    repos,
    superagent,
    users,
    loginRequired,
    hostLocalRequest,
    ...(loginPolicy ? { loginPolicy: async () => loginPolicy } : {}),
    capability,
    principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
  }
  /** Does this password sign the first admin in. */
  const adminPassword = (password: string) =>
    identity.credentials.verifyPassword(firstAdminMemberId(), password)
  return {
    caller: appRouter.createCaller(context),
    localCaller: appRouter.createCaller({ ...context, hostLocalRequest: true }),
    users,
    loginRequired,
    identity,
    memberId,
    adminPassword,
  }
}

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('auth tRPC (my own password · this instance’s login policy)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-authrtr-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('status reports instance policy and the CALLER’s own credential', async () => {
    const { caller, identity } = await harness()
    expect(await caller.auth.status()).toEqual({
      loginRequired: false,
      hasOwnCredential: false,
      canManageInstance: true,
      hostLocalRequest: true,
      loginPolicySource: 'default',
      loginRequiredReason: null,
    })
    await identity.credentials.setPassword(firstAdminMemberId(), 'hunter2')
    expect(await caller.auth.status()).toEqual({
      loginRequired: true,
      hasOwnCredential: true,
      canManageInstance: true,
      hostLocalRequest: true,
      loginPolicySource: 'default',
      loginRequiredReason: null,
    })
  })

  it.each([
    'hosted',
    'several-members',
  ] as const)('reports the composed %s policy reason through the auth family', async (loginRequiredReason) => {
    const { caller } = await harness(false, { loginRequired: true, loginRequiredReason })
    await expect(caller.auth.status()).resolves.toMatchObject({
      loginRequired: true,
      loginRequiredReason,
    })
  })

  it('reads and changes only the caller email, retaining the display name', async () => {
    const { caller, users } = await harness()
    const before = await users.get(firstAdminMemberId())
    expect(await caller.auth.profile()).toMatchObject({ email: null })
    await caller.auth.setEmail({ email: ' Alice@Example.COM ' })
    expect(await caller.auth.profile()).toMatchObject({ email: 'alice@example.com' })
    expect((await users.get(firstAdminMemberId()))?.displayName).toBe(before?.displayName)
    await caller.auth.setPassword({ next: 'hunter2' })
    await expect(caller.auth.setEmail({ email: 'next@example.com' })).rejects.toThrow(
      'current password',
    )
    await expect(
      caller.auth.setEmail({ email: 'next@example.com', current: 'wrong' }),
    ).rejects.toThrow('current password')
    await caller.auth.setEmail({ email: 'next@example.com', current: 'hunter2' })
    expect(await caller.auth.profile()).toMatchObject({ email: 'next@example.com' })
    await expect(caller.auth.setEmail({ email: '', current: 'hunter2' })).rejects.toThrow()
    await expect(
      caller.auth.setEmail({ email: 'not-an-email', current: 'hunter2' }),
    ).rejects.toThrow()
  })

  it('lets a non-admin change their own email without changing the admin', async () => {
    const { caller, users, memberId, identity } = await harness(true)
    await expect(caller.auth.setEmail({ email: 'member@example.com' })).rejects.toThrow(
      'current password',
    )
    await caller.auth.setEmail({ email: 'member@example.com', current: 'member-password' })
    expect(await caller.auth.profile()).toMatchObject({ email: 'member@example.com' })
    expect((await users.get(firstAdminMemberId()))?.email).toBeNull()
    expect((await users.byEmail('member@example.com'))?.id).toBe(memberId)
    // The address is the account's identifier: the member signs in with the new one.
    await identity.signIn({ email: 'member@example.com', password: 'member-password' })
    await expect(
      identity.signIn({ email: 'first@example.com', password: 'member-password' }),
    ).rejects.toThrow('invalid')
  })

  it('refuses a duplicate workspace email without changing either member', async () => {
    const { caller, users, identity } = await harness()
    const other = await identity.addMember({ name: 'Other', email: 'other@example.com' })
    await expect(caller.auth.setEmail({ email: 'OTHER@example.com' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(await caller.auth.profile()).toMatchObject({ email: null })
    expect((await users.byEmail('other@example.com'))?.id).toBe(other)
  })

  it('lets a member rename only themselves and retains their email, avatar and role', async () => {
    const { caller, users, memberId: id } = await harness(true)
    await users.writeProfile(id, 'Member', 'https://example.com/avatar.png')
    const admin = await users.get(firstAdminMemberId())
    await caller.auth.setDisplayName({ displayName: '  New name  ' })
    expect(await caller.auth.profile()).toMatchObject({
      id,
      displayName: 'New name',
      role: 'member',
    })
    expect(await users.get(id)).toMatchObject({
      displayName: 'New name',
      avatar: 'https://example.com/avatar.png',
      email: 'first@example.com',
      role: 'member',
    })
    expect(await users.get(firstAdminMemberId())).toEqual(admin)
    await expect(caller.auth.setDisplayName({ displayName: ' ' })).rejects.toThrow()
    await expect(caller.auth.setDisplayName({ displayName: 'a'.repeat(201) })).rejects.toThrow()
    await expect(
      caller.auth.setDisplayName({ displayName: 'Other', userId: firstAdminMemberId() } as never),
    ).rejects.toThrow()
    expect((await users.get(id))?.displayName).toBe('New name')
  })

  it('sets the caller’s own credential without requiring a current password', async () => {
    const { caller, adminPassword } = await harness()
    await caller.auth.setPassword({ next: 'first-pw' })
    expect(await adminPassword('first-pw')).toBe(true)
  })

  it('changing a password requires the correct current one', async () => {
    const { caller, adminPassword } = await harness()
    await caller.auth.setPassword({ next: 'old-pw' })
    await expect(caller.auth.setPassword({ current: 'wrong', next: 'new-pw' })).rejects.toThrow()
    await expect(caller.auth.setPassword({ next: 'new-pw' })).rejects.toThrow()
    expect(await adminPassword('old-pw')).toBe(true)
    await caller.auth.setPassword({ current: 'old-pw', next: 'new-pw' })
    expect(await adminPassword('new-pw')).toBe(true)
    expect(await adminPassword('old-pw')).toBe(false)
  })

  it('rejects an empty new password', async () => {
    const { caller } = await harness()
    await expect(caller.auth.setPassword({ next: '' })).rejects.toThrow()
  })

  it('requires explicit acknowledgement before turning login off', async () => {
    const { caller, loginRequired } = await harness()
    await caller.auth.setPassword({ next: 'hunter2' })
    await expect(
      caller.auth.setLoginRequired({ required: false, current: 'hunter2' }),
    ).rejects.toThrow()
    expect(await loginRequired()).toBe(true)
  })

  it('refuses remote turn-off but lets an authenticated admin restore required sign-in', async () => {
    const { caller, localCaller, loginRequired } = await harness(false, undefined, false)
    await caller.auth.setPassword({ next: 'hunter2' })
    expect(await caller.auth.status()).toMatchObject({
      canManageInstance: true,
      hostLocalRequest: false,
      loginRequired: true,
    })
    await expect(
      caller.auth.setLoginRequired({
        required: false,
        current: 'hunter2',
        acknowledgeNoPassword: true,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Turn off sign-in from the server machine itself.',
    })
    expect(await loginRequired()).toBe(true)
    await localCaller.auth.setLoginRequired({
      required: false,
      current: 'hunter2',
      acknowledgeNoPassword: true,
    })
    expect(await loginRequired()).toBe(false)
    await caller.auth.setLoginRequired({ required: true, current: 'hunter2' })
    expect(await loginRequired()).toBe(true)
  })

  it('turns login off for the instance WITHOUT destroying the credential', async () => {
    const { caller, adminPassword, loginRequired } = await harness()
    await caller.auth.setPassword({ next: 'hunter2' })

    await expect(
      caller.auth.setLoginRequired({
        required: false,
        current: 'wrong',
        acknowledgeNoPassword: true,
      }),
    ).rejects.toThrow()
    expect(await loginRequired()).toBe(true)

    await caller.auth.setLoginRequired({
      required: false,
      current: 'hunter2',
      acknowledgeNoPassword: true,
    })
    expect(await loginRequired()).toBe(false)
    expect(loadConfig().auth?.openMode).toBeUndefined()
    // THE PROPERTY THE CONFIG FLAG BUYS: nobody's password was deleted, so turning login
    // back on does not make everyone re-enrol.
    expect(await adminPassword('hunter2')).toBe(true)
  })

  it('turns login back on with the same password still working', async () => {
    const { caller, adminPassword, loginRequired } = await harness()
    await caller.auth.setPassword({ next: 'hunter2' })
    await caller.auth.setLoginRequired({
      required: false,
      current: 'hunter2',
      acknowledgeNoPassword: true,
    })
    await caller.auth.setLoginRequired({ required: true, current: 'hunter2' })
    expect(await loginRequired()).toBe(true)
    expect(await adminPassword('hunter2')).toBe(true)
  })
})
