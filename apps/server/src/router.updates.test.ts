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

function harness(requestCoordinatorRestart?: () => void) {
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
    ...(requestCoordinatorRestart ? { requestCoordinatorRestart } : {}),
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

  it('refuses a convergence request when every place is already on target', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.2'
    const { registry, caller } = harness()
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: '0.4.2' },
      [],
      '2026-08-10T00:00:00.000Z',
    )
    registry.modules.updates.setTarget(target())

    await expect(caller.updates.converge()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Podium is already at this version everywhere.',
    })
    registry.dispose()
  })

  it('starts a machine-only wave while the coordinating server is current', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.2'
    const { registry, caller } = harness()
    const grants: unknown[] = []

    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: '0.4.2' },
      [],
      '2026-08-10T00:00:00.000Z',
    )
    registry.sessionStore.machines.upsertMachine({
      id: 'flatblock',
      name: 'Flatblock',
      hostname: 'flatblock',
      tokenHash: 'flatblock-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.modules.machines.setMachineBuild(
      'flatblock',
      { appVersion: '0.4.1' },
      [],
      '2026-08-10T00:00:00.000Z',
    )
    registry.gateway.attachDaemon('flatblock', (message) => grants.push(message))
    registry.modules.updates.setTarget(target())

    const result = await caller.updates.converge()
    expect(result).toMatchObject({
      state: 'in-progress',
      version: '0.4.2',
      total: 1,
      grantedMachineIds: ['flatblock'],
    })
    expect(grants).toEqual([expect.objectContaining({ type: 'updateGrant' })])
    registry.dispose()
  })

  it('returns an in-progress wave after the human authorizes convergence', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.1'
    const requestCoordinatorRestart = vi.fn()
    const { registry, caller } = harness(requestCoordinatorRestart)
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: '0.4.2' },
      [],
      '2026-08-10T00:00:00.000Z',
    )
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
    expect(requestCoordinatorRestart).toHaveBeenCalledOnce()
    registry.dispose()
  })

  it('does not count or grant a machine selected onto another channel', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.2'
    const { registry, caller } = harness()
    registry.sessionStore.machines.upsertMachine({
      id: 'stable-machine',
      name: 'Stable machine',
      hostname: 'stable-machine',
      tokenHash: 'stable-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.modules.machines.setUpdateChannel('stable-machine', 'stable')
    registry.modules.machines.setMachineBuild(
      'stable-machine',
      { appVersion: '0.4.1' },
      [],
      '2026-08-10T00:00:00.000Z',
    )
    registry.modules.updates.setTarget(target())

    const fleet = await caller.updates.fleet()
    expect(fleet.machines.map((machine) => machine.id)).not.toContain('stable-machine')
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
