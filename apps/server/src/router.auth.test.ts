import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId, firstAdminMemberId } from '@podium/model'
import type { Capability } from '@podium/model'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { loadConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'

import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

/**
 * ONE registry per test, so `users` is a REAL repository: `auth.*` writes credential rows
 * now, and a fake store would let the per-caller scoping pass without ever proving a row
 * moved. `loginRequired` is composed the way server.ts composes it.
 */
async function harness(member = false) {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const users = registry.sessionStore.users
  const loginRequired = async (): Promise<boolean> =>
    !loadConfig().auth?.openMode && (await users.hasPerUserCredentials())
  const memberId = asUserId('user:profile-member')
  if (member)
    await users.create(
      {
        id: memberId,
        displayName: 'Member',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      await hashPassword('member-password'),
    )
  const capability: Capability = member
    ? {
        role: 'worker',
        scope: { kind: 'owned', userId: memberId },
        actorUser: memberId,
        onBehalfOf: memberId,
      }
    : OPERATOR
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    users,
    loginRequired,
    capability,
    principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
  })
  return { caller, users, loginRequired }
}

const hashOf = async (users: {
  credentialFor(
    id: string,
  ):
    | { passwordHash: string | null }
    | undefined
    | Promise<{ passwordHash: string | null } | undefined>
}) => (await users.credentialFor(firstAdminMemberId()))?.passwordHash ?? ''

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
    const { caller, users } = await harness()
    expect(await caller.auth.status()).toEqual({
      loginRequired: false,
      hasOwnCredential: false,
      canManageInstance: true,
    })
    await users.setPasswordHash(
      firstAdminMemberId(),
      await hashPassword('hunter2'),
      new Date().toISOString(),
    )
    expect(await caller.auth.status()).toEqual({
      loginRequired: true,
      hasOwnCredential: true,
      canManageInstance: true,
    })
  })

  it('reads and changes only the caller email, retaining the display name', async () => {
    const { caller, users } = await harness()
    const before = await users.get(firstAdminMemberId())
    expect(await caller.auth.profile()).toEqual({ email: null })
    await caller.auth.setEmail({ email: ' Alice@Example.COM ' })
    expect(await caller.auth.profile()).toEqual({ email: 'alice@example.com' })
    expect((await users.get(firstAdminMemberId()))?.displayName).toBe(before?.displayName)
    await caller.auth.setPassword({ next: 'hunter2' })
    await expect(caller.auth.setEmail({ email: 'next@example.com' })).rejects.toThrow(
      'current password',
    )
    await expect(
      caller.auth.setEmail({ email: 'next@example.com', current: 'wrong' }),
    ).rejects.toThrow('current password')
    await caller.auth.setEmail({ email: 'next@example.com', current: 'hunter2' })
    expect(await caller.auth.profile()).toEqual({ email: 'next@example.com' })
    await expect(caller.auth.setEmail({ email: '', current: 'hunter2' })).rejects.toThrow()
    await expect(
      caller.auth.setEmail({ email: 'not-an-email', current: 'hunter2' }),
    ).rejects.toThrow()
  })

  it('lets a non-admin change their own email without changing the admin', async () => {
    const { caller, users } = await harness(true)
    await caller.auth.setEmail({ email: 'member@example.com', current: 'member-password' })
    expect(await caller.auth.profile()).toEqual({ email: 'member@example.com' })
    expect((await users.get(firstAdminMemberId()))?.email).toBeNull()
    expect((await users.byEmail('member@example.com'))?.id).toBe('user:profile-member')
  })

  it('refuses a duplicate workspace email without changing either member', async () => {
    const { caller, users } = await harness()
    await users.create(
      {
        id: 'user:other',
        displayName: 'Other',
        email: 'other@example.com',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      await hashPassword('other-password'),
    )
    await expect(caller.auth.setEmail({ email: 'OTHER@example.com' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(await caller.auth.profile()).toEqual({ email: null })
    expect((await users.byEmail('other@example.com'))?.id).toBe('user:other')
  })

  it('sets the caller’s own credential without requiring a current password', async () => {
    const { caller, users } = await harness()
    await caller.auth.setPassword({ next: 'first-pw' })
    expect(await verifyPasswordHash('first-pw', await hashOf(users))).toBe(true)
  })

  it('changing a password requires the correct current one', async () => {
    const { caller, users } = await harness()
    await caller.auth.setPassword({ next: 'old-pw' })
    await expect(caller.auth.setPassword({ current: 'wrong', next: 'new-pw' })).rejects.toThrow()
    expect(await verifyPasswordHash('old-pw', await hashOf(users))).toBe(true)
    await caller.auth.setPassword({ current: 'old-pw', next: 'new-pw' })
    expect(await verifyPasswordHash('new-pw', await hashOf(users))).toBe(true)
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

  it('turns login off for the instance WITHOUT destroying the credential', async () => {
    const { caller, users, loginRequired } = await harness()
    await caller.auth.setPassword({ next: 'hunter2' })
    const hashBefore = await hashOf(users)

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
    // THE PROPERTY THE CONFIG FLAG BUYS: nobody's password was deleted, so turning login
    // back on does not make everyone re-enrol.
    expect(await hashOf(users)).toBe(hashBefore)
    expect(await users.hasPerUserCredentials()).toBe(true)
  })

  it('turns login back on with the same password still working', async () => {
    const { caller, users, loginRequired } = await harness()
    await caller.auth.setPassword({ next: 'hunter2' })
    await caller.auth.setLoginRequired({
      required: false,
      current: 'hunter2',
      acknowledgeNoPassword: true,
    })
    await caller.auth.setLoginRequired({ required: true, current: 'hunter2' })
    expect(await loginRequired()).toBe(true)
    expect(await verifyPasswordHash('hunter2', await hashOf(users))).toBe(true)
  })
})
