import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, FIRST_ADMIN_USER_ID, type UpdateChannel } from '@podium/model'
import type { MobileWebIdentity, UpdateTarget } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SessionStore } from './store'
import { OPERATOR } from './test-support/capabilities'

/**
 * A resolved release target, WITH THE ARTIFACT A RESOLVED ONE ALWAYS HAS.
 *
 * It used to be `artifacts: {}`, which no resolver can produce —
 * `resolveReleaseTarget` refuses a manifest with no headless artifact — and
 * which now means something specific: a descriptor pointing at no bytes, i.e.
 * a source host's pre-release identity. The fleet is right to refuse to wave
 * one, so the fixture has to be the thing it stands for.
 */
const target = (version = '0.4.2'): UpdateTarget =>
  ({
    version,
    critical: false,
    trust: 'release',
    artifacts: {
      headless: {
        delivery: 'feed',
        platforms: {
          'linux-x86_64': {
            url: `https://github.com/madeinorbit/podium/releases/download/edge/podium-headless-${version}.tar.gz`,
            digest: 'sha256-fixture',
            signature: 'sig',
          },
        },
      },
    },
  }) as UpdateTarget

const priorAppVersion = process.env.PODIUM_APP_VERSION
const priorChannel = process.env.PODIUM_UPDATE_CHANNEL

interface HarnessOptions {
  store?: SessionStore
  serverInstallKind?: 'installed' | 'source'
  /**
   * THIS MACHINE'S OWN UPDATE RECEIVER (POD-2668): the host daemon on an
   * all-in-one, the parent-backed local participant on a server-only box. Either
   * one makes the coordinator's machine a rollout target like any other, and
   * `false` is the coordinator that has neither — the only shape whose plan
   * still carries a `server` step.
   */
  hostUpdateReceiver?: false | ((message: unknown) => void)
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

const temporaryStores: Array<{ store: SessionStore; directory: string }> = []

/**
 * A coordinator restart is gated on a durable database snapshot. Memory stores
 * intentionally cannot produce one, so restart-order tests use a disposable
 * file-backed store and keep the production gate armed.
 */
function fileBackedStore(): SessionStore {
  const directory = mkdtempSync(join(tmpdir(), 'podium-router-updates-'))
  const store = new SessionStore(join(directory, 'podium.db'))
  temporaryStores.push({ store, directory })
  return store
}

function harness(requestCoordinatorRestart?: (() => void) | HarnessOptions) {
  const opts =
    typeof requestCoordinatorRestart === 'function'
      ? { requestCoordinatorRestart }
      : (requestCoordinatorRestart ?? {})
  const registry = new SessionRegistry(opts.store, undefined, { instanceId: 'updates-test' })
  const hostMachineId = registry.sessionStore.hostMachineId
  const hostUpdateReceiver = opts.hostUpdateReceiver ?? (() => {})
  if (hostUpdateReceiver !== false) registry.gateway.attachDaemon(hostMachineId, hostUpdateReceiver)
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
    ...(opts.serverInstallKind ? { serverInstallKind: opts.serverInstallKind } : {}),
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
  for (const { store, directory } of temporaryStores.splice(0)) {
    try {
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
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
      .mockResolvedValue(true)

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
      .mockResolvedValue(true)

    const machine = registry.modules.updates.fleet().find((row) => row.id === 'unpinned')
    expect(registry.modules.updates.channelOf(machine as never)).toBe('dev')

    await caller.machines.applyUpdate({ id: 'unpinned' })

    expect(refreshTarget.mock.calls.map(([channel]) => channel)).toEqual(['dev'])
    registry.dispose()
  })

  it('updates Podium on a machine whose agent software is not Podium-managed', async () => {
    const { registry, caller } = harness()
    registry.sessionStore.machines.upsertMachine({
      id: 'shared',
      name: 'Shared machine',
      hostname: 'shared',
      tokenHash: 'shared-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
      podiumManaged: false,
    })
    const sharedMachineId = asMachineId('shared')
    registry.gateway.attachDaemon(sharedMachineId, () => {})
    registry.modules.machines.setMachineBuild(
      sharedMachineId,
      { appVersion: '0.4.1' },
      [],
      '2026-08-26T00:00:00.000Z',
    )
    const refreshTarget = vi
      .spyOn(registry.modules.updates, 'refreshTarget')
      .mockResolvedValue(true)
    registry.modules.updates.setTarget('dev', target())

    await caller.machines.setUpdateChannel({ id: 'shared', channel: 'dev' })
    const { outcome } = await caller.machines.applyUpdate({ id: 'shared' })

    expect(registry.modules.machines.updateChannel(sharedMachineId)).toBe('dev')
    expect(refreshTarget.mock.calls.map(([channel]) => channel)).toEqual(['dev', 'dev'])
    expect(outcome).toEqual({ result: 'granted', version: '0.4.2' })
    registry.dispose()
  })

  it('lets a pin win over the fleet default on every path', async () => {
    process.env.PODIUM_UPDATE_CHANNEL = 'edge'
    const { registry, caller } = harness()
    addMachine(registry, 'pinned')
    registry.modules.machines.setUpdateChannel(asMachineId('pinned'), 'stable')
    const refreshTarget = vi
      .spyOn(registry.modules.updates, 'refreshTarget')
      .mockResolvedValue(true)

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
          // The resolver names the manifest boundary so feed failures stay actionable.
          reason: 'stable target unavailable: release manifest getaddrinfo ENOTFOUND',
        },
      },
    ])
    fetchSpy.mockRestore()
    registry.dispose()
  })

  it('adds current component identities to the existing fleet payload', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.1'
    const { registry, caller } = harness({
      servedWebDigest: '47a01e3',
      servedMobileWeb: {
        present: true,
        appVersion: '0.4.1',
        digest: '47a01e3',
      },
    })

    await expect(caller.updates.fleet()).resolves.toMatchObject({
      appVersion: '0.4.1',
      servedWebDigest: '47a01e3',
      servedMobileWeb: {
        present: true,
        appVersion: '0.4.1',
        digest: '47a01e3',
      },
    })
    registry.dispose()
  })

  it('does not integrity-check database snapshots while polling fleet state', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.1'
    const { registry, caller } = harness()
    registry.modules.updates.setTarget(target())
    const latestSnapshot = vi.spyOn(registry.sessionStore, 'latestDatabaseSnapshot')

    await caller.updates.fleet()
    await caller.updates.fleet()

    expect(latestSnapshot).not.toHaveBeenCalled()
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

/**
 * THE FLEET READ MODEL FOLLOWS THE OPERATION'S AUTHORITY (POD-2222/POD-2212).
 *
 * POD-2100 narrowed this read model to the `dev` authority, with a stated
 * reason: edge and stable machines carry their own per-row targets, and
 * comparing them against the DEV target would invent behind places the global
 * action could not grant. That reasoning was right and its premise expired —
 * POD-2189 made the global action's authority the HOST's own channel, so on a
 * stable installation the read model and the action stopped describing the same
 * wave. The consequence the live drive found: a stable-pinned installation is
 * never counted as behind, and so is never OFFERED the update it could take.
 *
 * The widening is therefore exactly one channel wide — the same
 * `operationChannel` the mutation uses — which is what keeps "no invented
 * grantable places" true: the set counted here IS the set that mutation grants.
 */
describe('the fleet counted is the fleet the global action would grant', () => {
  const hostAt = (
    registry: ReturnType<typeof harness>['registry'],
    channel: UpdateChannel,
    appVersion: string,
  ) => {
    const id = registry.sessionStore.hostMachineId
    registry.modules.machines.setUpdateChannel(id, channel)
    registry.modules.machines.setMachineBuild(id, { appVersion }, [], '2026-08-13T00:00:00.000Z')
  }

  /** THE DEFECT: a real stable release, a host behind it, and a read model that
   *  reported an empty dev wave — `targetVersion` null, nothing behind. */
  it('counts a stable-pinned host as behind its own stable target', async () => {
    const { registry, caller } = harness()
    hostAt(registry, 'stable', '0.1.2')
    registry.modules.updates.setTarget('stable', target('0.1.3'))

    const fleet = await caller.updates.fleet()

    expect(fleet.targetVersion).toBe('0.1.3')
    expect(fleet.total).toBe(1)
    expect(fleet.behind).toBe(1)
    expect(fleet.machines.map((machine) => machine.id)).toEqual([
      registry.sessionStore.hostMachineId,
    ])
    registry.dispose()
  })
  it('excludes a source checkout while retaining an outdated packaged machine', async () => {
    const release = '0.1.1-dev.1+6e57311'
    const { registry, caller } = harness({ serverInstallKind: 'source' })
    const host = registry.sessionStore.hostMachineId
    registry.modules.machines.setMachineBuild(
      host,
      { appVersion: 'dev+6e57311', installKind: 'source' },
      ['podium.shipping-train'],
      '2026-08-22T00:00:00.000Z',
    )
    registry.sessionStore.machines.upsertMachine({
      id: 'packaged',
      name: 'Packaged',
      hostname: 'packaged',
      tokenHash: 'packaged-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.gateway.attachDaemon(asMachineId('packaged'), () => {})
    registry.modules.machines.setUpdateChannel(asMachineId('packaged'), 'dev')
    registry.modules.machines.setMachineBuild(
      asMachineId('packaged'),
      { appVersion: '0.1.1-dev.0+old0000', installKind: 'installed' },
      ['update.delivery.feed', 'podium.shipping-train'],
      '2026-08-22T00:00:00.000Z',
    )
    registry.modules.updates.setTarget('dev', target(release))

    const offered = await caller.updates.fleet()
    expect(offered.total).toBe(1)
    expect(offered.behind).toBe(1)
    expect(offered.machines.map((machine) => machine.id)).toEqual(['packaged'])
    expect(offered.allMachines.map((machine) => machine.id)).toContain(host)

    registry.modules.machines.setMachineBuild(
      asMachineId('packaged'),
      { appVersion: release, installKind: 'installed' },
      ['update.delivery.feed', 'podium.shipping-train'],
      '2026-08-22T00:01:00.000Z',
    )
    const current = await caller.updates.fleet()
    expect(current.behind).toBe(0)
    expect(current.startability).toEqual({
      startable: false,
      reason: 'Podium is already at this version everywhere.',
    })
    await expect(caller.updates.start()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    registry.dispose()
  })

  /**
   * WHY THE READ MODEL IS PART OF THE OFFER AND NOT ONLY OF SETTINGS.
   *
   * Fixing `/version` alone is enough whenever the COORDINATOR is itself behind,
   * because `serverBehind` then produces a place and the panel has something to
   * show. This is the fleet where it is not: the coordinator is current, its
   * website is current, and the only place left to name is other machines —
   * which `describeUpdate` draws from `fleet.behind` alone. Dev-scoped, that
   * count is zero on a stable fleet, `placesFor` returns nothing, and
   * `describeUpdate` answers `{state:'none'}`: no offer, for a wave
   * `updates.start` would plan and grant in full.
   */
  it('counts a behind stable machine when the coordinator itself is current', async () => {
    const { registry, caller } = harness()
    hostAt(registry, 'stable', '0.1.3')
    registry.sessionStore.machines.upsertMachine({
      id: 'stable-vps',
      name: 'VPS',
      hostname: 'vps',
      tokenHash: 'vps-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.modules.machines.setUpdateChannel(asMachineId('stable-vps'), 'stable')
    registry.modules.machines.setMachineBuild(
      asMachineId('stable-vps'),
      { appVersion: '0.1.2' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.modules.updates.setTarget('stable', target('0.1.3'))

    const fleet = await caller.updates.fleet()

    expect(fleet.total).toBe(2)
    // The one number the panel's remaining place row is drawn from.
    expect(fleet.behind).toBe(1)
    registry.dispose()
  })

  /**
   * THE NARROWING THAT MUST SURVIVE. A dev coordinator still counts only its
   * dev wave: a stable machine sitting in the same directory is not the global
   * action's business, keeps its own per-row action, and must not appear as a
   * behind place this dialog cannot move.
   */
  it('still leaves an off-channel machine out of the wave the dialog counts', async () => {
    const { registry, caller } = harness()
    hostAt(registry, 'dev', 'dev+47a01e3')
    registry.sessionStore.machines.upsertMachine({
      id: 'stable-vps',
      name: 'VPS',
      hostname: 'vps',
      tokenHash: 'vps-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.modules.machines.setUpdateChannel(asMachineId('stable-vps'), 'stable')
    registry.modules.machines.setMachineBuild(
      asMachineId('stable-vps'),
      { appVersion: '0.1.2' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.modules.updates.setTarget('dev', target('dev+47a01e3'))
    registry.modules.updates.setTarget('stable', target('0.1.3'))

    const fleet = await caller.updates.fleet()

    expect(fleet.targetVersion).toBe('dev+47a01e3')
    expect(fleet.total).toBe(1)
    expect(fleet.behind).toBe(0)
    // Settings still gets every row, so the stable machine's own convergence
    // remains visible where its own action lives.
    expect(fleet.allMachines.map((machine) => machine.id)).toContain('stable-vps')
    registry.dispose()
  })

  /** The invariant behind both cases, asserted directly rather than implied. */
  it('scopes the wave to the same channel the operation would be computed on', async () => {
    const { registry, caller } = harness()
    hostAt(registry, 'stable', '0.1.2')
    registry.modules.updates.setTarget('stable', target('0.1.3'))

    const fleet = await caller.updates.fleet()
    const channel = registry.modules.updates.operationChannel(registry.sessionStore.hostMachineId)

    expect(channel).toBe('stable')
    expect(fleet.targetVersion).toBe(registry.modules.updates.target(channel)?.version)
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

  /**
   * §6.3's last line: never show an internal precondition as an error. "No
   * update target is configured." is the internal precondition — it describes
   * the server's own bookkeeping and tells the operator nothing they can act
   * on. An empty channel is an ordinary state of the world, and it is sayable.
   */
  it('refuses a convergence request in prose when nothing is published', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.1'
    const { registry, caller } = harness()

    await expect(caller.updates.converge()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Nothing has been published on the development channel yet.',
    })
    registry.dispose()
  })

  /**
   * POD-2197. A dirty source checkout is the reason a target is missing, and the
   * publisher already knows the sentence — "The source checkout has 2
   * uncommitted changes and no longer matches HEAD (ee135e3). Commit or stash
   * them to publish dev+ee135e3." Observed live (POD-2194): that sentence stayed
   * in `preparation.failureDetail` while the caller was told "No update target
   * is configured.", which is both the banned string and the useless half.
   */
  it('quotes the publisher when it is the reason there is no target', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+ee135e3'
    const detail =
      'The source checkout has 2 uncommitted changes and no longer matches HEAD (ee135e3). ' +
      'Commit or stash them to publish dev+ee135e3.'
    const { registry, caller } = harness({
      updatePreparation: () => ({ webReady: false, bundleReady: false, failureDetail: detail }),
    })

    await expect(caller.updates.converge()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: detail,
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

  /**
   * POD-2195, END TO END, AS IT STANDS AFTER THE PULL CONVERSION.
   *
   * It used to read: a machine running from source advertises git delivery and
   * nothing else, and the bare identity the publisher puts up names a repo and
   * a sha — everything that machine needs — so the update must reach it without
   * packing a tarball first. Git delivery is retired (spec disposition 5), and
   * with it that whole path: a source machine advertises NO delivery, and an
   * identity target names nothing anyone can take.
   *
   * What survives is the shape of the original bug, which was a machine left at
   * "Waiting for the update package." forever. The fleet below is the one the
   * dev channel actually has now — a machine that CAN take a feed — and the
   * guarantee is that the ordinary published feed target reaches it.
   */
  function devFleet(requestDestBundle: () => Promise<unknown>) {
    const { registry, caller } = harness({ servedWebDigest: '47a01e3', requestDestBundle })
    const grants: unknown[] = []
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: 'dev+47a01e3' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.sessionStore.machines.upsertMachine({
      id: 'source-machine',
      name: 'Source',
      hostname: 'source',
      tokenHash: 'source-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.modules.machines.setUpdateChannel(asMachineId('source-machine'), 'dev')
    // The caps an INSTALLED daemon reports (`build-report.ts`): a feed, and
    // nothing else now that the bundle kind is retired.
    registry.modules.machines.setMachineBuild(
      asMachineId('source-machine'),
      { appVersion: 'dev+aaaaaaa' },
      ['update.delivery.feed'],
      '2026-08-13T00:00:00.000Z',
    )
    registry.gateway.attachDaemon('source-machine', (message) => grants.push(message))
    // A published dev release, as the resolver hands it over: an ordinary feed
    // artifact, on the instance trust root.
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      trust: 'instance',
      artifacts: {
        web: { digest: '47a01e3' },
        headless: {
          delivery: 'feed',
          platforms: {
            'linux-x64': {
              url: 'http://source.test/updates/feed/dev/artifact/dev%2B47a01e3',
              digest: 'd',
              signature: 's',
            },
          },
        },
      },
    } as UpdateTarget)
    return { registry, caller, grants }
  }

  it('grants a published dev release without asking for another build', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
    const requestDestBundle = vi.fn().mockResolvedValue(undefined)
    const { registry, caller, grants } = devFleet(requestDestBundle)

    const result = await caller.updates.converge()
    expect(result).toMatchObject({
      state: 'in-progress',
      version: 'dev+47a01e3',
      grantedMachineIds: ['source-machine'],
    })
    expect(requestDestBundle).not.toHaveBeenCalled()
    expect(grants).toHaveLength(1)
    registry.dispose()
  })

  /**
   * The read model has to agree with the wave, or Settings tells the operator
   * nothing is happening while a machine is mid-fetch. Its `grantable` flag
   * asked the target-only question too, so a source fleet's live counts were
   * zeroed for the want of a tarball nobody wanted.
   */
  it('counts a dev machine mid-grant as converging', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+47a01e3'
    const { registry, caller } = devFleet(vi.fn().mockResolvedValue(undefined))

    await caller.updates.converge()
    await expect(caller.updates.fleet()).resolves.toMatchObject({ converging: 1 })
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
    /**
     * ORDER REVERSED, DELIBERATELY (POD-2098). The old choreography rebuilt the
     * website first and then packed around it. The operation packs first,
     * because an EXPLICIT pack rebuilds `apps/web/dist` on its way to the
     * tarball (`decideWebDist`) — so the website is a consequence of preparing,
     * not a separate round, and the `web` step's reality check then usually
     * passes without acting. One build instead of two.
     */
    await vi.waitFor(() => expect(requestDestBundle).toHaveBeenCalledOnce())
    // Nothing is granted while the target is still a bare identity: the wave
    // may not learn by failing (POD-2004), and the `machines` step says so by
    // staying in flight rather than by handing out a package that does not
    // exist.
    expect(grants).toEqual([])
    expect(requestWebRebuild).not.toHaveBeenCalled()
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
          delivery: 'feed',
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

  /**
   * REPLACES "redeploys this server when dest packaging fails and the server is
   * behind" (POD-2098, spec §7).
   *
   * Restarting anyway was a silent substitution: the operator asked for an
   * update of every place and got one place, with the failure visible only as a
   * log line. `preparation-failed` is a TYPED outcome with a sentence and a next
   * action, and the operation it attaches to is retryable — which is the whole
   * of P7. Nothing was handed out before the pack failed, so nothing is
   * half-applied by refusing to continue.
   */
  it('fails with a typed preparation error instead of silently redeploying', async () => {
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

    // The legacy alias has only one failure channel — a rejection — so that is
    // how the shipped dialog still hears about it.
    await expect(caller.updates.converge()).rejects.toThrow('compile failed')
    expect(requestCoordinatorRestart).not.toHaveBeenCalled()

    // …and the operation itself is on record, typed and retryable.
    const failed = await caller.operations.history({ kind: 'update' })
    expect(failed[0]).toMatchObject({
      state: 'failed',
      error: { code: 'preparation-failed' },
    })
    registry.dispose()
  })

  /**
   * WHO REPLACES THE COORDINATOR — the one question these two tests split
   * between them (POD-2738).
   *
   * They were one test, written when the coordinator's own process was always
   * replaced by `requestCoordinatorRestart`, and it kept its fixture while the
   * design underneath it changed. POD-2668 made the coordinator's machine an
   * ordinary update receiver — a host daemon on an all-in-one, a parent-backed
   * local participant on a server-only box — and the planner now refuses to
   * plan a `server` step for a machine the fleet is already going to swap
   * (`hostUpdatesThroughFleet`): one receiver per machine, never two.
   *
   * So the old test's fixture — a host registered with `setMachineBuild`, hence
   * a participant — stopped being able to observe the callback it asserted, and
   * would have gone green again for a coordinator swapped TWICE. Each half is
   * now pinned where it is real:
   *
   * - `restarts the coordinator only after the machine wave finishes` keeps the
   *   ordering promise, in the topology that still has a `server` step.
   * - `converges the coordinator through its own fleet grant…` pins the new
   *   path, where the restart arrives as a grant and the callback must not fire
   *   at all.
   */
  it('restarts the coordinator only after the machine wave finishes', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+aaaaaaa'
    const requestCoordinatorRestart = vi.fn()
    let finish: (() => void) | undefined
    const requestDestBundle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const store = fileBackedStore()
    const grants: unknown[] = []
    // A coordinator with no update receiver of its own: no host daemon, no
    // local participant. Nothing in the fleet will swap this machine, so the
    // operation owns its replacement and the `server` step is planned.
    const { registry, caller } = harness({
      store,
      hostUpdateReceiver: false,
      requestCoordinatorRestart,
      requestDestBundle,
      servedWebDigest: '47a01e3',
    })
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

    // The coordinator itself can take a source update and must not force a pack
    // (POD-2198). A bundle-only remote is the place this test says is waiting on
    // packaging; without it there is correctly no prepare step anymore.
    const bundleMachine = asMachineId('bundle-machine')
    registry.sessionStore.machines.upsertMachine({
      id: bundleMachine,
      name: 'Bundle machine',
      hostname: 'bundle-machine',
      tokenHash: 'bundle-machine-token',
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    registry.modules.machines.setUpdateChannel(bundleMachine, 'dev')
    registry.modules.machines.setMachineBuild(
      bundleMachine,
      { appVersion: 'dev+aaaaaaa' },
      ['update.delivery.bundle'],
      '2026-08-13T00:00:00.000Z',
    )
    registry.gateway.attachDaemon(bundleMachine, (message) => grants.push(message))

    await caller.updates.converge()
    expect(requestCoordinatorRestart).not.toHaveBeenCalled()
    expect(
      registry.modules.operations.engine
        .active('lifecycle')
        ?.operation?.steps?.map((step) => step.id),
    ).toContain('prepare')
    await vi.waitFor(() => expect(requestDestBundle).toHaveBeenCalledOnce())
    expect(requestCoordinatorRestart).not.toHaveBeenCalled()

    // THE ORDER IS THE PLAN'S, not a poll loop's: the step that replaces this
    // process is last, because it is what ends the process driving the wave.
    const planned = (await caller.operations.active()) as {
      steps?: { id: string }[]
    } | null
    expect(planned?.steps?.map((step) => step.id)).toEqual(['prepare', 'machines', 'server'])

    /**
     * THE PACK RESOLVES, THE MACHINE IS GRANTED — AND THE SERVER STILL DOES NOT
     * RESTART YET.
     *
     * This is the step ordering the old 250 ms poll loop
     * (`restartCoordinatorAfterDevelopmentFleet`) used to express: the machines
     * go first, because restarting this process is what ends the process
     * driving them. It is now simply the order of the plan — `machines` before
     * `server` — with no loop and no 60-minute backstop.
     */
    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: {
        web: { digest: '47a01e3' },
        headless: {
          delivery: 'feed',
          platforms: { 'linux-x64': { url: 'http://bundle', digest: 'd', signature: 's' } },
        },
      },
    })
    finish?.()
    await vi.waitFor(() =>
      expect(grants).toEqual([expect.objectContaining({ type: 'updateGrant' })]),
    )
    expect(requestCoordinatorRestart).not.toHaveBeenCalled()

    // The one waved machine reports the target, so the wave is done and the
    // plan reaches the step that replaces this process.
    registry.modules.machines.setMachineBuild(
      asMachineId('installed-edge'),
      { appVersion: 'dev+47a01e3' },
      [],
      '2026-08-13T00:00:01.000Z',
    )
    registry.bus.emit('machine.connected', { machineId: asMachineId('installed-edge') })
    await vi.waitFor(() => expect(requestCoordinatorRestart).toHaveBeenCalledOnce())
    registry.dispose()
  })

  it('converges the coordinator through its own fleet grant, never the restart callback', async () => {
    process.env.PODIUM_APP_VERSION = 'dev+aaaaaaa'
    const requestCoordinatorRestart = vi.fn()
    let finish: (() => void) | undefined
    const requestDestBundle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const store = fileBackedStore()
    const hostControl: unknown[] = []
    // The all-in-one / server-only shape after POD-2668: this machine has an
    // update receiver, so it is a rollout target like any other.
    const { registry, caller } = harness({
      store,
      hostUpdateReceiver: (message) => hostControl.push(message),
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
    await vi.waitFor(() => expect(requestDestBundle).toHaveBeenCalledOnce())

    // NO `server` STEP AT ALL. The coordinator is in the wave, and a machine the
    // wave will swap must not also be swapped from underneath it.
    const planned = (await caller.operations.active()) as {
      steps?: { id: string }[]
    } | null
    expect(planned?.steps?.map((step) => step.id)).toEqual(['prepare', 'machines'])

    registry.modules.updates.setTarget({
      version: 'dev+47a01e3',
      critical: false,
      artifacts: {
        web: { digest: '47a01e3' },
        headless: {
          delivery: 'feed',
          platforms: { 'linux-x64': { url: 'http://bundle', digest: 'd', signature: 's' } },
        },
      },
    })
    finish?.()

    // The replacement arrives as this machine's own grant — the parent applies
    // it and hands the process over — so the callback is never reached.
    await vi.waitFor(() =>
      expect(hostControl).toEqual([expect.objectContaining({ type: 'updateGrant' })]),
    )
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: 'dev+47a01e3' },
      [],
      '2026-08-13T00:00:01.000Z',
    )
    registry.bus.emit('machine.connected', { machineId: registry.sessionStore.hostMachineId })
    await vi.waitFor(async () =>
      expect((await caller.operations.history({ kind: 'update' }))[0]).toMatchObject({
        state: 'done',
        steps: [
          expect.objectContaining({ id: 'prepare', state: 'done' }),
          expect.objectContaining({ id: 'machines', state: 'done' }),
        ],
      }),
    )
    expect(requestCoordinatorRestart).not.toHaveBeenCalled()
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
    const store = fileBackedStore()
    const { registry, caller } = harness({ store, requestCoordinatorRestart })
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

/**
 * THE DURABLE UPDATE OPERATION, through the router (POD-2098).
 *
 * `updates.start` is what the panel calls; `updates.converge` above is the
 * shipped dialog's entry point, kept for one release and now a thin alias over
 * this. Everything here is about the properties the OPERATION adds: an identity,
 * single-flight, a queue, a remainder retry.
 */
describe('the update operation', () => {
  function behindHarness(options: Parameters<typeof harness>[0] = {}) {
    process.env.PODIUM_APP_VERSION = '0.4.1'
    const built = harness(options)
    built.registry.modules.machines.setMachineBuild(
      built.registry.sessionStore.hostMachineId,
      { appVersion: '0.4.1' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    built.registry.modules.updates.setTarget(target())
    return built
  }

  it('answers an operation id, and puts it on the fleet payload for the old panel', async () => {
    const { registry, caller } = behindHarness({ requestCoordinatorRestart: () => {} })
    const latestSnapshot = vi.spyOn(registry.sessionStore, 'latestDatabaseSnapshot')
    const started = await caller.updates.start()
    expect(started.operationId).toMatch(/^op_/)
    expect(latestSnapshot).toHaveBeenCalled()
    expect(started.alreadyRunning).toBe(false)
    expect(started.operation).toMatchObject({ kind: 'update', state: 'running' })

    const fleet = await caller.updates.fleet()
    expect(fleet.operationId).toBe(started.operationId)

    const active = (await caller.operations.active()) as { id: string } | null
    expect(active?.id).toBe(started.operationId)
    registry.dispose()
  })

  /**
   * §8's "two tabs / two users click Update". The second caller is handed the
   * SAME operation rather than an error, which is what makes both tabs render
   * one panel instead of one of them reporting a conflict.
   */
  it('gives two concurrent starts one operation id', async () => {
    const { registry, caller } = behindHarness({ requestCoordinatorRestart: () => {} })
    const [first, second] = await Promise.all([caller.updates.start(), caller.updates.start()])
    expect(second.operationId).toBe(first.operationId)
    expect(second.alreadyRunning).toBe(true)
    expect(await caller.operations.history({ kind: 'update' })).toHaveLength(1)
    registry.dispose()
  })

  /**
   * §3.2/§8: "a new version lands mid-update". The running wave is NEVER
   * mutated; the newcomer waits and is offered when the operation terminates.
   */
  it('queues a version published mid-operation and does not change the running target', async () => {
    const { registry, caller } = behindHarness({ requestCoordinatorRestart: () => {} })
    await caller.updates.start()
    registry.modules.updates.setTarget(target('0.4.3'))

    expect(registry.modules.updates.target('dev')?.version).toBe('0.4.2')
    const fleet = await caller.updates.fleet()
    expect(fleet.targetVersion).toBe('0.4.2')
    expect(fleet.nextTargetVersion).toBe('0.4.3')

    // The operation ends; the queued version becomes an OFFER, not a second
    // operation — the human decision was about the version that just finished.
    registry.modules.operations.engine.cancel(fleet.operationId as string)
    expect(registry.modules.updates.target('dev')?.version).toBe('0.4.3')
    expect((await caller.updates.fleet()).nextTargetVersion).toBeUndefined()
    expect(registry.modules.operations.engine.active('lifecycle')).toBeUndefined()
    registry.dispose()
  })

  it('retries the remainder as a NEW operation, linked to the one it retries', async () => {
    const { registry, caller } = behindHarness({ requestCoordinatorRestart: () => {} })
    const first = await caller.updates.start()
    registry.modules.operations.engine.cancel(first.operationId)

    const retried = await caller.updates.retry({ id: first.operationId })
    expect(retried.operationId).not.toBe(first.operationId)
    expect(retried.operation).toMatchObject({ retryOf: first.operationId })
    // History stays honest: the attempt that failed is still on record.
    const history = await caller.operations.history({ kind: 'update' })
    expect(history).toHaveLength(2)
    registry.dispose()
  })

  it('refuses to retry an update it has no record of', async () => {
    const { registry, caller } = behindHarness()
    await expect(caller.updates.retry({ id: 'op_nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    registry.dispose()
  })

  it('still refuses to start when every place is already on target', async () => {
    process.env.PODIUM_APP_VERSION = '0.4.2'
    const { registry, caller } = harness()
    registry.modules.machines.setMachineBuild(
      registry.sessionStore.hostMachineId,
      { appVersion: '0.4.2' },
      [],
      '2026-08-13T00:00:00.000Z',
    )
    registry.modules.updates.setTarget(target())
    await expect(caller.updates.fleet()).resolves.toMatchObject({
      startability: {
        startable: false,
        reason: 'Podium is already at this version everywhere.',
      },
    })
    await expect(caller.updates.start()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Podium is already at this version everywhere.',
    })
    // …and no operation was manufactured just to carry that refusal (§6.3).
    expect(await caller.operations.history({ kind: 'update' })).toHaveLength(0)
    registry.dispose()
  })
})
