import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIRST_ADMIN_USER_ID } from '@podium/model'
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
function harness() {
  const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
  const users = registry.sessionStore.users
  const loginRequired = (): boolean => !loadConfig().auth?.openMode && users.hasPerUserCredentials()
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    users,
    loginRequired,
    capability: OPERATOR,
    principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
  })
  return { caller, users, loginRequired }
}

const hashOf = (users: {
  credentialFor(id: string): { passwordHash: string | null } | undefined
}) => users.credentialFor(FIRST_ADMIN_USER_ID)?.passwordHash ?? ''

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
    const { caller, users } = harness()
    expect(await caller.auth.status()).toEqual({
      loginRequired: false,
      hasOwnCredential: false,
      canManageInstance: true,
    })
    users.setPasswordHash(
      FIRST_ADMIN_USER_ID,
      await hashPassword('hunter2'),
      new Date().toISOString(),
    )
    expect(await caller.auth.status()).toEqual({
      loginRequired: true,
      hasOwnCredential: true,
      canManageInstance: true,
    })
  })

  it('sets the caller’s own credential without requiring a current password', async () => {
    const { caller, users } = harness()
    await caller.auth.setPassword({ next: 'first-pw' })
    expect(await verifyPasswordHash('first-pw', hashOf(users))).toBe(true)
  })

  it('changing a password requires the correct current one', async () => {
    const { caller, users } = harness()
    await caller.auth.setPassword({ next: 'old-pw' })
    await expect(caller.auth.setPassword({ current: 'wrong', next: 'new-pw' })).rejects.toThrow()
    expect(await verifyPasswordHash('old-pw', hashOf(users))).toBe(true)
    await caller.auth.setPassword({ current: 'old-pw', next: 'new-pw' })
    expect(await verifyPasswordHash('new-pw', hashOf(users))).toBe(true)
  })

  it('rejects an empty new password', async () => {
    const { caller } = harness()
    await expect(caller.auth.setPassword({ next: '' })).rejects.toThrow()
  })

  it('requires explicit acknowledgement before turning login off', async () => {
    const { caller, loginRequired } = harness()
    await caller.auth.setPassword({ next: 'hunter2' })
    await expect(
      caller.auth.setLoginRequired({ required: false, current: 'hunter2' }),
    ).rejects.toThrow()
    expect(loginRequired()).toBe(true)
  })

  it('turns login off for the instance WITHOUT destroying the credential', async () => {
    const { caller, users, loginRequired } = harness()
    await caller.auth.setPassword({ next: 'hunter2' })
    const hashBefore = hashOf(users)

    await expect(
      caller.auth.setLoginRequired({
        required: false,
        current: 'wrong',
        acknowledgeNoPassword: true,
      }),
    ).rejects.toThrow()
    expect(loginRequired()).toBe(true)

    await caller.auth.setLoginRequired({
      required: false,
      current: 'hunter2',
      acknowledgeNoPassword: true,
    })
    expect(loginRequired()).toBe(false)
    // THE PROPERTY THE CONFIG FLAG BUYS: nobody's password was deleted, so turning login
    // back on does not make everyone re-enrol.
    expect(hashOf(users)).toBe(hashBefore)
    expect(users.hasPerUserCredentials()).toBe(true)
  })

  it('turns login back on with the same password still working', async () => {
    const { caller, users, loginRequired } = harness()
    await caller.auth.setPassword({ next: 'hunter2' })
    await caller.auth.setLoginRequired({
      required: false,
      current: 'hunter2',
      acknowledgeNoPassword: true,
    })
    await caller.auth.setLoginRequired({ required: true, current: 'hunter2' })
    expect(loginRequired()).toBe(true)
    expect(await verifyPasswordHash('hunter2', hashOf(users))).toBe(true)
  })
})
