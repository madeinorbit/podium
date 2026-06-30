import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasPassword, setPassword, verifyPassword } from './auth-store'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SuperagentService } from './superagent'

function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon('local', () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry, repos, registry.sessionStore)
  return appRouter.createCaller({ registry, repos, superagent })
}

describe('auth tRPC (set / change / clear the login password)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-authrtr-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
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

  it('clears (disables) the password when the correct current one is given', async () => {
    await setPassword('hunter2', dir)
    await expect(caller().auth.clearPassword({ current: 'wrong' })).rejects.toThrow()
    expect(hasPassword(dir)).toBe(true)
    await caller().auth.clearPassword({ current: 'hunter2' })
    expect(hasPassword(dir)).toBe(false)
  })
})
