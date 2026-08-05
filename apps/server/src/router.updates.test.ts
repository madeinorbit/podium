import { FIRST_ADMIN_USER_ID } from '@podium/model'
import type { UpdateTarget } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

const target = (version = '0.4.2'): UpdateTarget =>
  ({ version, critical: false, artifacts: {} }) as UpdateTarget

const priorAppVersion = process.env.PODIUM_APP_VERSION

function harness() {
  const registry = new SessionRegistry(undefined, undefined, { instanceId: 'updates-test' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin'),
  })
  return { registry, caller }
}

afterEach(() => {
  if (priorAppVersion === undefined) delete process.env.PODIUM_APP_VERSION
  else process.env.PODIUM_APP_VERSION = priorAppVersion
})

describe('updates tRPC', () => {
  it('refuses a convergence request when no target is configured', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.1'
    const { registry, caller } = harness()

    await expect(caller.updates.converge()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'No update target is configured.',
    })
    registry.dispose()
  })

  it('refuses a convergence request when the server is already on its target', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.2'
    const { registry, caller } = harness()
    registry.modules.updates.setTarget(target())

    await expect(caller.updates.converge()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'The server is already at this version.',
    })
    registry.dispose()
  })

  it('returns an in-progress wave after the human authorizes convergence', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.1'
    const { registry, caller } = harness()
    registry.modules.updates.setTarget(target())

    const result = await caller.updates.converge()
    expect(result).toMatchObject({
      state: 'in-progress',
      version: '0.4.2',
      done: 0,
    })
    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.fleet.targetVersion).toBe('0.4.2')
    expect(result.fleet.machines.length).toBeGreaterThanOrEqual(1)
    registry.dispose()
  })

  it('exposes the fleet query and propagates convergence failures', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.1'
    const { registry, caller } = harness()
    registry.modules.updates.setTarget(target())

    const fleet = await caller.updates.fleet()
    expect(fleet).toMatchObject({ targetVersion: '0.4.2', total: 1, behind: 1 })
    expect(fleet.machines[0]).toMatchObject({ state: 'current' })

    vi.spyOn(registry.modules.updates, 'tick').mockImplementation(() => {
      throw new Error('The update transport is unavailable.')
    })
    await expect(caller.updates.converge()).rejects.toThrow('The update transport is unavailable.')
    registry.dispose()
  })
})
