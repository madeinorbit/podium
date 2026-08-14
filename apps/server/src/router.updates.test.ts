import { asMachineId, FIRST_ADMIN_USER_ID } from '@podium/model'
import type { MobileWebIdentity, UpdateTarget } from '@podium/protocol'
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

interface HarnessOptions {
  requestCoordinatorRestart?: () => void
  requestWebRebuild?: () => void
  requestDestBundle?: () => Promise<unknown>
  servedWebDigest?: string | (() => string | undefined)
  servedMobileWeb?: MobileWebIdentity
  updatePreparation?: () => {
    webReady: boolean
    bundleReady: boolean
    failureDetail?: string
  }
}

function harness(requestCoordinatorRestart?: (() => void) | HarnessOptions) {
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
  const readServedWeb =
    typeof opts.servedWebDigest === 'function'
      ? opts.servedWebDigest
      : opts.servedWebDigest !== undefined
        ? () => opts.servedWebDigest as string
        : undefined
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
    ...(opts.requestDestBundle ? { requestDestBundle: opts.requestDestBundle } : {}),
    ...(opts.updatePreparation ? { updatePreparation: opts.updatePreparation } : {}),
    ...(readServedWeb ? { servedWebDigest: readServedWeb } : {}),
    ...(opts.servedMobileWeb !== undefined
      ? { servedMobileWeb: () => opts.servedMobileWeb as MobileWebIdentity }
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

/**
 * POD-2100. The disagreement this replaces was not subtle:
 * `UpdatesService.channelOf` resolved a machine with no pin to `dev` while
 * `machines.setUpdateChannel` and `machines.applyUpdate` resolved the SAME
 * machine to `stable`. Which authority a machine belonged to depended on which
 * code path asked, which decides which target it is granted.
 *
 * The claim under test is an identity, so the test states it as one: one machine,
 * three paths, one channel.
 */
describe('one default channel', () => {
  function addMachine(registry: ReturnType<typeof harness>['registry'], id: string) {
    registry.sessionStore.machines.upsertMachine({
      id,
      name: id,
      hostname: id,
      tokenHash: `${id}-token`,
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
  }

  it('resolves an unpinned machine identically through channelOf and both fleet handlers', async () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'edge'
    const { registry, caller } = harness()
    addMachine(registry, 'unpinned')
    const refreshTarget = vi
      .spyOn(registry.modules.updates, 'refreshTarget')
      .mockResolvedValue(undefined)

    const machine = registry.modules.updates.fleet().find((row) => row.id === 'unpinned')
    expect(machine).toBeDefined()
    expect(registry.modules.updates.channelOf(machine as never)).toBe('edge')

    await caller.machines.setUpdateChannel({ id: 'unpinned', channel: null })
    await caller.machines.applyUpdate({ id: 'unpinned' })

    // Not merely "each handler refreshed something" — the SAME channel the
    // service would grant against, twice.
    expect(refreshTarget.mock.calls.map(([channel]) => channel)).toEqual(['edge', 'edge'])
    registry.dispose()
  })

  it('follows the fleet default onto dev as readily as onto stable', async () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'dev'
    const { registry, caller } = harness()
    addMachine(registry, 'unpinned')
    const refreshTarget = vi
      .spyOn(registry.modules.updates, 'refreshTarget')
      .mockResolvedValue(undefined)

    const machine = registry.modules.updates.fleet().find((row) => row.id === 'unpinned')
    expect(registry.modules.updates.channelOf(machine as never)).toBe('dev')

    await caller.machines.applyUpdate({ id: 'unpinned' })

    expect(refreshTarget.mock.calls.map(([channel]) => channel)).toEqual(['dev'])
    registry.dispose()
  })

  it('lets a pin win over the fleet default on every path', async () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'edge'
    const { registry, caller } = harness()
    addMachine(registry, 'pinned')
    registry.modules.machines.setUpdateChannel(asMachineId('pinned'), 'stable')
    const refreshTarget = vi
      .spyOn(registry.modules.updates, 'refreshTarget')
      .mockResolvedValue(undefined)

    const machine = registry.modules.updates.fleet().find((row) => row.id === 'pinned')
    expect(registry.modules.updates.channelOf(machine as never)).toBe('stable')

    await caller.machines.applyUpdate({ id: 'pinned' })

    expect(refreshTarget.mock.calls.map(([channel]) => channel)).toEqual(['stable'])
    registry.dispose()
  })
})

/**
 * Spec §9.2 makes the refresh cadence part of the contract — "checked 2 h ago"
 * has to be renderable, which means the check has to be recorded and exposed.
 */
describe('release target checks', () => {
  /** The release feed is stubbed: a unit lane must never reach the network. */
  const offline = () =>
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))

  it('exposes per-channel checked-at and outcome on the fleet payload', async () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'stable'
    const fetchSpy = offline()
    const { registry, caller } = harness()
    await registry.modules.updates.refreshTarget('stable')

    const fleet = await caller.updates.fleet()

    expect(fleet.channelChecks).toEqual([
      {
        channel: 'stable',
        checkedAt: expect.any(Number),
        outcome: {
          status: 'unavailable',
          reason: 'stable target unavailable: getaddrinfo ENOTFOUND',
        },
      },
    ])
    fetchSpy.mockRestore()
    registry.dispose()
  })

  it('has nothing to say about a channel it has never checked', async () => {
    const { registry, caller } = harness()

    await expect(caller.updates.fleet()).resolves.toMatchObject({ channelChecks: [] })
    registry.dispose()
  })

  it('checkNow checks the channels in use and returns their outcomes', async () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'stable'
    const fetchSpy = offline()
    const { registry, caller } = harness()

    const results = await caller.updates.checkNow()

    // The host machine is pinned to `dev` by the harness, and the fleet default
    // is `stable`; both are in use, nothing else is — `edge` is not polled for
    // nobody's benefit.
    expect(results.map((record) => record.channel)).toEqual(['dev', 'stable'])
    expect(results.every((record) => record.outcome.status === 'unavailable')).toBe(true)
    fetchSpy.mockRestore()
    registry.dispose()
  })
})

describe('updates tRPC', () => {
  it('reports coordinator preparation readiness and failures with the fleet', async () => {
    const preparation = {
      webReady: false,
      bundleReady: false,
      failureDetail: 'The website could not be rebuilt. See the server log.',
    }
    const { registry, caller } = harness({ updatePreparation: () => preparation })

    await expect(caller.updates.fleet()).resolves.toMatchObject({ preparation })
    registry.dispose()
  })

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
    let digest = 'aaaaaaa'
    const requestWebRebuild = vi.fn(() => {
      digest = '47a01e3'
    })
    const { registry, caller } = harness({
      requestWebRebuild,
      servedWebDigest: () => digest,
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
    const requestDestBundle = vi.fn().mockResolvedValue(undefined)
    const { registry, caller } = harness({
      servedWebDigest: '47a01e3',
      requestDestBundle,
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

    const fleet = await caller.updates.fleet()
    expect(fleet.behind).toBe(1)
    const result = await caller.updates.converge()
    expect(result).toMatchObject({
      state: 'in-progress',
      version: 'dev+47a01e3',
      grantedMachineIds: [],
    })
    await vi.waitFor(() => expect(requestDestBundle).toHaveBeenCalledOnce())
    expect(grants).toEqual([])
    registry.dispose()
  })

  it('rebuilds dest web without dest-granting dest remotes when dest has no dest tarball', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
    let digest = 'aaaaaaa'
    const requestWebRebuild = vi.fn(() => {
      digest = '47a01e3'
    })
    const requestDestBundle = vi.fn().mockResolvedValue(undefined)
    const { registry, caller } = harness({
      requestWebRebuild,
      requestDestBundle,
      servedWebDigest: () => digest,
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
    await vi.waitFor(() => expect(requestDestBundle).toHaveBeenCalledOnce())
    expect(requestDestBundle.mock.invocationCallOrder[0]).toBeGreaterThan(
      requestWebRebuild.mock.invocationCallOrder[0] ?? 0,
    )
    expect(grants).toEqual([])
    registry.dispose()
  })

  it('grants remotes once the dest package appears after Update', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
    const grants: unknown[] = []
    let publish: (() => void) | undefined
    const requestDestBundle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          publish = resolve
        }),
    )
    const { registry, caller } = harness({
      servedWebDigest: '47a01e3',
      requestDestBundle,
    })
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
    expect(result.grantedMachineIds).toEqual([])
    expect(grants).toEqual([])
    await vi.waitFor(() => expect(requestDestBundle).toHaveBeenCalledOnce())
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: {
        web: { digest: '47a01e3' },
        headless: {
          delivery: 'bundle',
          platforms: {
            'linux-x64': { url: 'http://bundle', digest: 'd', signature: 's' },
          },
        },
      },
    })
    publish?.()
    await vi.waitFor(() =>
      expect(grants).toEqual([expect.objectContaining({ type: 'updateGrant' })]),
    )
    registry.dispose()
  })

  it('redeploys this server when dest packaging fails and the server is behind', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+aaaaaaa'
    const requestCoordinatorRestart = vi.fn()
    const requestDestBundle = vi.fn().mockRejectedValue(new Error('compile failed'))
    const { registry, caller } = harness({
      requestCoordinatorRestart,
      requestDestBundle,
      servedWebDigest: '47a01e3',
    })
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: 'dev+aaaaaaa' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    })

    await caller.updates.converge()
    await vi.waitFor(() => expect(requestCoordinatorRestart).toHaveBeenCalledOnce())
    registry.dispose()
  })

  it('does not dest-redeploy immediately while dest packaging is still running', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+aaaaaaa'
    const requestCoordinatorRestart = vi.fn()
    let finish: (() => void) | undefined
    const requestDestBundle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const { registry, caller } = harness({
      requestCoordinatorRestart,
      requestDestBundle,
      servedWebDigest: '47a01e3',
    })
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: 'dev+aaaaaaa' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    })

    await caller.updates.converge()
    expect(requestCoordinatorRestart).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(requestDestBundle).toHaveBeenCalledOnce())
    expect(requestCoordinatorRestart).not.toHaveBeenCalled()
    finish?.()
    await vi.waitFor(() => expect(requestCoordinatorRestart).toHaveBeenCalledOnce())
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

  /**
   * THE PHONE IS THE OTHER HALF OF THE SAME WEBSITE (POD-1980). One
   * `podium-web` run builds both dists and `artifacts.web.digest` names one
   * commit for both, so a fresh desktop shell must not certify a phone export
   * left behind by a failed or skipped export.
   */
  describe('the phone website', () => {
    /** Server and target both on dev+47a01e3, so only a dist can be behind. */
    const settle = (registry: SessionRegistry): void => {
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
    }

    it('CAN SAY NO: rebuilds when only the phone export is on an older commit', async () => {
      process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
      const requestWebRebuild = vi.fn()
      const { registry, caller } = harness({
        requestWebRebuild,
        servedWebDigest: '47a01e3',
        servedMobileWeb: { present: true, digest: 'aaaaaaa' },
      })
      settle(registry)

      const result = await caller.updates.converge()
      expect(result).toMatchObject({ state: 'in-progress', version: 'dev+47a01e3' })
      expect(requestWebRebuild).toHaveBeenCalledOnce()
      registry.dispose()
    })

    it('rebuilds a phone export that cannot name its commit at all', async () => {
      process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
      const requestWebRebuild = vi.fn()
      const { registry, caller } = harness({
        requestWebRebuild,
        servedWebDigest: '47a01e3',
        servedMobileWeb: { present: true },
      })
      settle(registry)

      await caller.updates.converge()
      expect(requestWebRebuild).toHaveBeenCalledOnce()
      registry.dispose()
    })

    it('leaves an installation with no phone website alone', async () => {
      process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
      const requestWebRebuild = vi.fn()
      const { registry, caller } = harness({
        requestWebRebuild,
        servedWebDigest: '47a01e3',
        servedMobileWeb: { present: false },
      })
      settle(registry)

      await expect(caller.updates.converge()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Podium is already at this version everywhere.',
      })
      expect(requestWebRebuild).not.toHaveBeenCalled()
      registry.dispose()
    })

    it('is current when both dists name the target commit', async () => {
      process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
      const requestWebRebuild = vi.fn()
      const { registry, caller } = harness({
        requestWebRebuild,
        servedWebDigest: '47a01e3',
        servedMobileWeb: { present: true, digest: '47a01e3' },
      })
      settle(registry)

      await expect(caller.updates.converge()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      })
      expect(requestWebRebuild).not.toHaveBeenCalled()
      registry.dispose()
    })
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
