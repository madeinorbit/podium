import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPassword, setPassword, verifyPassword } from '@podium/runtime/auth-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'
import { OPERATOR } from './issue-authz'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'

function caller() {
  const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
  return appRouter.createCaller({
    registry,
    repos,
    superagent,
    capability: OPERATOR,
    principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
  })
}

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('auth tRPC (set / change / clear the login password)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-authrtr-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('status reflects whether a password is configured', async () => {
    expect(await caller().auth.status()).toEqual({ enabled: false })
    await setPassword('hunter2', dir)
    expect(await caller().auth.status()).toEqual({ enabled: true })
  })

  it('sets a password from open mode without requiring a current one', async () => {
    await caller().auth.setPassword({ next: 'first-pw' })
    expect(hasPassword(dir)).toBe(true)
    expect(await verifyPassword('first-pw', dir)).toBe(true)
  })

  it('changing a password requires the correct current one', async () => {
    await setPassword('old-pw', dir)
    await expect(caller().auth.setPassword({ current: 'wrong', next: 'new-pw' })).rejects.toThrow()
    expect(await verifyPassword('old-pw', dir)).toBe(true)
    await caller().auth.setPassword({ current: 'old-pw', next: 'new-pw' })
    expect(await verifyPassword('new-pw', dir)).toBe(true)
  })

  it('rejects an empty new password', async () => {
    await expect(caller().auth.setPassword({ next: '' })).rejects.toThrow()
  })

  it('requires explicit acknowledgement before clearing the password', async () => {
    await setPassword('hunter2', dir)
    await expect(caller().auth.clearPassword({ current: 'hunter2' })).rejects.toThrow()
    expect(hasPassword(dir)).toBe(true)
  })

  it('clears (disables) the password when the correct current one is given and open mode is acknowledged', async () => {
    await setPassword('hunter2', dir)
    await expect(
      caller().auth.clearPassword({ current: 'wrong', acknowledgeNoPassword: true }),
    ).rejects.toThrow()
    expect(hasPassword(dir)).toBe(true)
    await caller().auth.clearPassword({ current: 'hunter2', acknowledgeNoPassword: true })
    expect(hasPassword(dir)).toBe(false)
  })
})
