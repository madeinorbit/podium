import { asMachineId, FIRST_ADMIN_USER_ID } from '@podium/model'
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
const priorChannel = process.env.PODIUM_UPDATE_CHANNEL

function harness(
  requestCoordinatorRestart?: (() => void) | {
    requestCoordinatorRestart?: () => void
    requestWebRebuild?: () => void
    servedWebDigest?: string
  },
) {
  const opts =
    typeof requestCoordinatorRestart === 'function'
      ? { requestCoordinatorRestart }
      : (requestCoordinatorRestart ?? {})
  const registry = new SessionRegistry(undefined, undefined, { instanceId: 'updates-test' })
  const hostMachineId = registry.sessionStore.hostMachineId
  registry.gateway.attachDaemon(hostMachineId, () => {})
  registry.modules.machines.setUpdateChannel(hostMachineId, 'dev')
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin'),
    ...(opts.requestCoordinatorRestart
      ? { requestCoordinatorRestart: opts.requestCoordinatorRestart }
      : {}),
    ...(opts.requestWebRebuild ? { requestWebRebuild: opts.requestWebRebuild } : {}),
    ...(opts.servedWebDigest !== undefined
      ? { servedWebDigest: () => opts.servedWebDigest }
      : {}),
  })
  return { registry, caller }
}

afterEach(() => {
  if (priorAppVersion === undefined) delete process.env.PODIUM_APP_VERSION
  else process.env.PODIUM_APP_VERSION = priorAppVersion
  if (priorChannel === undefined) delete process.env.PODIUM_UPDATE_CHANNEL
  else process.env.PODIUM_UPDATE_CHANNEL = priorChannel
})

/**
 * POD-1882. A machine with no pin of its own follows the instance's fleet default,
 * and the fleet default is what Settings → Updates writes. `updateChannel` on the
 * wire is therefore the RESOLVED answer; `updateChannelOverride` is the pin.
 */
describe('fleet default update channel', () => {
  function addMachine(registry: ReturnType<typeof harness>['registry'], id: string) {
    registry.sessionStore.machines.upsertMachine({
      id,
      name: id,
      hostname: id,
      tokenHash: `${id}-token`,
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
  }

  it('resolves an unpinned machine onto the fleet default', () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'edge'
    const { registry } = harness()
    addMachine(registry, 'unpinned')

    const machine = registry.modules.machines
      .listMachines()
      .find((candidate) => candidate.id === 'unpinned')
    expect(machine?.updateChannelOverride ?? null).toBeNull()
    expect(machine?.updateChannel).toBe('edge')
    expect(registry.modules.machines.updateChannel(asMachineId('unpinned'))).toBe('edge')
    registry.dispose()
  })

  it('lets a pin win over the fleet default, and survives it changing', () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'edge'
    const { registry } = harness()
    addMachine(registry, 'pinned')
    registry.modules.machines.setUpdateChannel(asMachineId('pinned'), 'stable')

    expect(registry.modules.machines.updateChannel(asMachineId('pinned'))).toBe('stable')

    // The fleet moves; the pinned machine does not.
    process.env.PODIUM_UPDATE_CHANNEL = 'dev'
    expect(registry.modules.machines.updateChannel(asMachineId('pinned'))).toBe('stable')
    const pinned = registry.modules.machines
      .listMachines()
      .find((candidate) => candidate.id === 'pinned')
    expect(pinned?.updateChannelOverride).toBe('stable')
    registry.dispose()
  })

  it("moves an unpinned machine's resolved channel and target the moment the fleet default changes, and leaves a pinned one alone", () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'stable'
    const { registry } = harness()
    addMachine(registry, 'follower')
    addMachine(registry, 'pinned')
    registry.modules.machines.setUpdateChannel(asMachineId('pinned'), 'stable')
    registry.modules.updates.setTarget(target())

    const before = registry.modules.machines.listMachines()
    const followerBefore = before.find((m) => m.id === 'follower')
    expect(followerBefore?.updateChannel).toBe('stable')

    // The fleet default moves — exactly what Settings → Updates writes.
    process.env.PODIUM_UPDATE_CHANNEL = 'dev'
    registry.modules.machines.refreshFleetChannel()

    const after = registry.modules.machines.listMachines()
    expect(after.find((m) => m.id === 'follower')?.updateChannel).toBe('dev')
    // Target is resolved per machine from its channel, so it moves with it.
    expect(after.find((m) => m.id === 'follower')?.targetVersion).not.toBe(
      followerBefore?.targetVersion,
    )
    // The pin is the whole point: it does not follow.
    expect(after.find((m) => m.id === 'pinned')?.updateChannel).toBe('stable')
    expect(after.find((m) => m.id === 'pinned')?.targetVersion).toBe(
      before.find((m) => m.id === 'pinned')?.targetVersion,
    )
    registry.dispose()
  })

  it('hands a machine back to the fleet default when its pin is cleared', () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'edge'
    const { registry } = harness()
    addMachine(registry, 'released')
    registry.modules.machines.setUpdateChannel(asMachineId('released'), 'dev')
    expect(registry.modules.machines.updateChannel(asMachineId('released'))).toBe('dev')

    registry.modules.machines.setUpdateChannel(asMachineId('released'), null)

    expect(registry.modules.machines.updateChannel(asMachineId('released'))).toBe('edge')
    const released = registry.modules.machines
      .listMachines()
      .find((candidate) => candidate.id === 'released')
    expect(released?.updateChannelOverride ?? null).toBeNull()
    registry.dispose()
  })
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

  it('does not refuse when the server SHA matches but the served web stamp does not', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
    const requestWebRebuild = vi.fn()
    const { registry, caller } = harness({
      requestWebRebuild,
      servedWebDigest: 'aaaaaaa',
    })
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: 'dev+47a01e3' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    })

    const result = await caller.updates.converge()
    expect(result).toMatchObject({ state: 'in-progress', version: 'dev+47a01e3' })
    expect(requestWebRebuild).toHaveBeenCalledOnce()
    registry.dispose()
  })

  it('does not grant dest machines a dest+commit that dest cannot deliver', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
    const { registry, caller } = harness({ servedWebDigest: '47a01e3' })
    const grants: unknown[] = []
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: 'dev+47a01e3' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.sessionStore.machines.upsertMachine({
      id: 'installed-edge',
      name: 'Installed',
      hostname: 'installed',
      tokenHash: 'installed-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.modules.machines.setUpdateChannel(asMachineId('installed-edge'), 'dev')
    registry.modules.machines.setMachineBuild(
      asMachineId('installed-edge'),
      { appVersion: 'dev+aaaaaaa' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.gateway.attachDaemon('installed-edge', (message) => grants.push(message))
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    })

    const fleet = await caller.updates.fleet()
    expect(fleet.behind).toBe(0)
    await expect(caller.updates.converge()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Podium is already at this version everywhere.',
    })
    expect(grants).toEqual([])
    registry.dispose()
  })

  it('rebuilds dest web without dest-granting dest remotes when dest has no dest tarball', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
    const requestWebRebuild = vi.fn()
    const { registry, caller } = harness({
      requestWebRebuild,
      servedWebDigest: 'aaaaaaa',
    })
    const grants: unknown[] = []
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: 'dev+47a01e3' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.sessionStore.machines.upsertMachine({
      id: 'installed-edge',
      name: 'Installed',
      hostname: 'installed',
      tokenHash: 'installed-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.modules.machines.setUpdateChannel(asMachineId('installed-edge'), 'dev')
    registry.modules.machines.setMachineBuild(
      asMachineId('installed-edge'),
      { appVersion: 'dev+aaaaaaa' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.gateway.attachDaemon('installed-edge', (message) => grants.push(message))
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    })

    const result = await caller.updates.converge()
    expect(result).toMatchObject({ state: 'in-progress', version: 'dev+47a01e3' })
    expect(requestWebRebuild).toHaveBeenCalledOnce()
    expect(grants).toEqual([])
    registry.dispose()
  })

  it('still refuses when server, web stamp, and fleet all match', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
    const requestWebRebuild = vi.fn()
    const { registry, caller } = harness({
      requestWebRebuild,
      servedWebDigest: '47a01e3',
    })
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: 'dev+47a01e3' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    })

    await expect(caller.updates.converge()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Podium is already at this version everywhere.',
    })
    expect(requestWebRebuild).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('can rebuild a source web app even when the server is already on target', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.2'
    const requestCoordinatorRestart = vi.fn()
    const { registry, caller } = harness(requestCoordinatorRestart)
    registry.modules.updates.setTarget(target())

    await expect(caller.updates.repairCompatibility()).resolves.toEqual({
      state: 'in-progress',
      version: '0.4.2',
    })
    expect(requestCoordinatorRestart).toHaveBeenCalledOnce()
    registry.dispose()
  })

  it('explains when this installation cannot rebuild its web app', async () => {
    const { registry, caller } = harness()

    await expect(caller.updates.repairCompatibility()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'This Podium installation cannot rebuild its web app automatically.',
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
    registry.modules.machines.setUpdateChannel(asMachineId('flatblock'), 'dev')
    registry.modules.machines.setMachineBuild(
      asMachineId('flatblock'),
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
    registry.modules.machines.setUpdateChannel(asMachineId('stable-machine'), 'stable')
    registry.modules.machines.setMachineBuild(
      asMachineId('stable-machine'),
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
