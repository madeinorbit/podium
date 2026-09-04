import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIRST_ADMIN_USER_ID, type ServerReadiness } from '@podium/model'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { LAYERED_KEYS, loadConfig, saveConfig } from '@podium/runtime/config'
import { encodeJoin } from '@podium/runtime/join'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePrincipal } from './command-principal'
import { desktopUpdaterEndpoint, InstanceService } from './modules/instance/service'

import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { createServerReadiness } from './server-readiness'
import { OPERATOR } from './test-support/capabilities'

/**
 * ONE registry per test, memoised: `setup.complete`'s optional password is a CREDENTIAL ROW
 * on the calling account now, so a second `caller()` with its own store would be a different
 * instance and "keep the existing password" could not be expressed at all.
 */
let harness: ReturnType<typeof makeHarness> | undefined

function makeHarness() {
  const registry = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const users = registry.sessionStore.users
  return {
    users,
    caller: appRouter.createCaller({
      registry,
      repos,
      superagent,
      users,
      capability: OPERATOR,
      principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
    }),
  }
}

function caller() {
  harness ??= makeHarness()
  return harness.caller
}

/**
 * A caller that CAN restart its own process — the two context members POD-2766
 * added, which the default harness deliberately leaves unset so `activate`
 * refuses rather than claiming a restart nothing performed.
 */
function activationHarness(opts: {
  readiness: () => ServerReadiness
  requestCoordinatorRestart?: () => void
}) {
  const registry = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const users = registry.sessionStore.users
  return appRouter.createCaller({
    registry,
    repos,
    superagent,
    users,
    capability: OPERATOR,
    principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
    readiness: opts.readiness,
    ...(opts.requestCoordinatorRestart
      ? { requestCoordinatorRestart: opts.requestCoordinatorRestart }
      : {}),
  })
}

const pendingOn = (stale: readonly ('mode' | 'persistence')[]): ServerReadiness => ({
  state: 'activation_pending',
  reason: 'restart_required',
  dataPlane: 'blocked',
  controlPlane: 'available',
  stale,
})

const READY: ServerReadiness = {
  state: 'ready',
  reason: null,
  dataPlane: 'available',
  controlPlane: 'available',
}

/** The first admin's credential — what "a password is set" means after POD-1554. */
async function credentialHash(): Promise<string> {
  harness ??= makeHarness()
  return (await harness.users.credentialFor(FIRST_ADMIN_USER_ID))?.passwordHash ?? ''
}

async function seedPassword(password: string): Promise<void> {
  harness ??= makeHarness()
  await harness.users.setPasswordHash(
    FIRST_ADMIN_USER_ID,
    await hashPassword(password),
    new Date().toISOString(),
  )
}

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('setup tRPC', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setuprtr-'))
    process.env.PODIUM_STATE_DIR = dir
    harness = undefined
    // NO TEST IN THIS FILE REACCHES THE NETWORK. `setup.connect`/`join` ask the
    // remote for its `appUrl` (PDM-34); left unstubbed that is a real DNS lookup
    // for whatever hostname a fixture invented. An unreachable remote is also
    // the self-hosted answer, so this default is the behaviour every case here
    // predates — the split-hosting cases override it with an answer.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    harness = undefined
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists network options', async () => {
    expect((await caller().setup.options()).map((o) => o.id)).toContain('tailscale-funnel')
  })
  it('returns the funnel command', async () => {
    expect(
      (await caller().setup.commandFor({ option: 'tailscale-funnel', port: 18787 })).command,
    ).toBe('tailscale funnel 18787')
  })
  it('rejects a bad URL on complete', async () => {
    await expect(caller().setup.complete({ publicUrl: 'nope' })).rejects.toThrow()
  })
  it('persists a normalized publicUrl + all-in-one mode after open mode is acknowledged', async () => {
    await caller().setup.complete({
      publicUrl: 'https://box.ts.net/',
      acknowledgeNoPassword: true,
    })
    expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    expect(loadConfig().mode).toBe('all-in-one')
  })
  it('info reports the current mode + publicUrl (for Settings → Network)', async () => {
    // appVersion is the baked build version ('dev' from source) [POD-838].
    const appVersion = process.env.PODIUM_APP_VERSION ?? 'dev'
    // Every layered value carries the LAYER that answered (PDM-26), so a control
    // can render disabled and name the variable holding it rather than offering
    // a write the environment overrides.
    expect(await caller().setup.info()).toEqual({
      mode: null,
      modeSource: 'default',
      publicUrl: null,
      publicUrlSource: 'default',
      appUrl: null,
      appUrlSource: 'default',
      allowedOrigins: [],
      allowedOriginsSource: 'default',
      transcriptLake: 'on',
      transcriptLakeSource: 'default',
      networkOption: null,
      serverUrl: null,
      appVersion,
    })
    await caller().setup.complete({
      publicUrl: 'https://box.ts.net',
      networkOption: 'tailscale-serve',
      acknowledgeNoPassword: true,
    })
    expect(await caller().setup.info()).toEqual({
      mode: 'all-in-one',
      modeSource: 'file',
      publicUrl: 'https://box.ts.net',
      publicUrlSource: 'file',
      appUrl: null,
      appUrlSource: 'default',
      allowedOrigins: [],
      allowedOriginsSource: 'default',
      transcriptLake: 'on',
      transcriptLakeSource: 'default',
      networkOption: 'tailscale-serve',
      serverUrl: null,
      appVersion,
    })
  })
  it('complete with mode=server persists a reachable relay-only box', async () => {
    await caller().setup.complete({
      publicUrl: 'https://relay.ts.net',
      mode: 'server',
      acknowledgeNoPassword: true,
    })
    expect(loadConfig().mode).toBe('server')
    expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
  })
  it('sets the login password when one is supplied (network-exposed install)', async () => {
    await caller().setup.complete({ publicUrl: 'https://box.ts.net', password: 'launch-code' })
    expect(await verifyPasswordHash('launch-code', await credentialHash())).toBe(true)
  })
  it('rejects a reachable setup without password acknowledgement', async () => {
    await expect(caller().setup.complete({ publicUrl: 'https://box.ts.net' })).rejects.toThrow()
    expect(await credentialHash()).toBe('')
  })
  it('keeps an existing password when the URL is set later (no re-ack needed)', async () => {
    await seedPassword('already-set')
    // No password + no ack must NOT throw once one is already configured — it's "keep current".
    await caller().setup.complete({ publicUrl: 'https://relay.ts.net' })
    expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
    expect(await verifyPasswordHash('already-set', await credentialHash())).toBe(true) // unchanged
  })
  it('leaves auth open when no password is explicitly acknowledged', async () => {
    await caller().setup.complete({
      publicUrl: 'https://box.ts.net',
      acknowledgeNoPassword: true,
    })
    expect(await credentialHash()).toBe('')
  })
  /**
   * PDM-34: connect and join now ask the remote where its UI is. Nothing below
   * is about that answer — these are the pre-existing behaviours, and they must
   * be identical when the remote says nothing, which is every self-hosted
   * install and every offline test.
   */
  it('join applies a pasted join code as a daemon config', async () => {
    const code = encodeJoin({ v: 1, serverUrl: 'wss://relay', pairCode: 'P1', name: 'box' })
    expect(await caller().setup.join({ code })).toEqual({ name: 'box' })
    expect(loadConfig().mode).toBe('daemon')
    expect(loadConfig().serverUrl).toBe('wss://relay')
  })
  it('join rejects a malformed code', async () => {
    await expect(caller().setup.join({ code: 'garbage!' })).rejects.toThrow()
  })
  it('connect persists client mode + server URL', async () => {
    await caller().setup.connect({ mode: 'client', serverUrl: 'ws://host:18787' })
    expect(loadConfig().mode).toBe('client')
    expect(loadConfig().serverUrl).toBe('ws://host:18787')
  })
  it('connect persists server-only mode', async () => {
    await caller().setup.connect({ mode: 'server' })
    expect(loadConfig().mode).toBe('server')
  })
  it('connect rejects client mode without a server URL', async () => {
    await expect(caller().setup.connect({ mode: 'client' })).rejects.toThrow()
  })

  /**
   * SPLIT HOSTING (PDM-34). The one fact a person pasting an API address or a
   * join token cannot know is that the UI is somewhere else — so the server is
   * asked, and the answer is persisted as `uiUrl` for the desktop shell to read
   * on its next launch.
   */
  describe('learning where the remote serves its UI', () => {
    const remoteAdvertises = (body: unknown) =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => body,
      } as Response)

    it('join records the joined server’s app host', async () => {
      const fetchMock = remoteAdvertises({ appUrl: 'https://app.meetpodium.com' })
      const code = encodeJoin({ v: 1, serverUrl: 'wss://api.meetpodium.com', pairCode: 'P1' })
      await caller().setup.join({ code })
      expect(loadConfig().uiUrl).toBe('https://app.meetpodium.com')
      // Asked the server named in the TOKEN, over http(s), before writing anything.
      expect(String((fetchMock.mock.calls[0] as [URL])[0])).toBe(
        'https://api.meetpodium.com/version',
      )
    })

    it('connect records it for a client pointed at an API-only server', async () => {
      remoteAdvertises({ appUrl: 'https://app.meetpodium.com' })
      await caller().setup.connect({ mode: 'client', serverUrl: 'https://api.meetpodium.com' })
      expect(loadConfig().uiUrl).toBe('https://app.meetpodium.com')
    })

    it('leaves it unset when the remote serves its own UI', async () => {
      remoteAdvertises({ instanceId: 'i1' })
      await caller().setup.connect({ mode: 'client', serverUrl: 'https://self.hosted' })
      expect(loadConfig()).not.toHaveProperty('uiUrl')
    })

    it('does not ask on behalf of a local mode, and clears a stale answer', async () => {
      const fetchMock = remoteAdvertises({ appUrl: 'https://app.meetpodium.com' })
      await caller().setup.connect({ mode: 'client', serverUrl: 'https://api.meetpodium.com' })
      fetchMock.mockClear()
      // Going back to a local all-in-one: there is no remote to ask, and the
      // previous deployment's app host must not survive the switch.
      await caller().setup.connect({ mode: 'all-in-one' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(loadConfig()).not.toHaveProperty('uiUrl')
    })

    it('still joins when the remote cannot be reached', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
      const code = encodeJoin({ v: 1, serverUrl: 'wss://relay', pairCode: 'P1', name: 'box' })
      expect(await caller().setup.join({ code })).toEqual({ name: 'box' })
      expect(loadConfig().mode).toBe('daemon')
      expect(loadConfig()).not.toHaveProperty('uiUrl')
    })
  })
  it('reports the update channel (default stable)', async () => {
    expect(await caller().setup.channel()).toMatchObject({ channel: 'stable', envForced: false })
  })
  it('reports the dev shell endpoint from the deployment public URL', async () => {
    saveConfig({
      ...loadConfig(),
      updateChannel: 'dev',
      publicUrl: 'https://podium.test/',
    })
    expect(await caller().setup.channel()).toMatchObject({
      channel: 'dev',
      desktopUpdateEndpoint: 'https://podium.test/updates/feed/dev/latest.json',
    })
    expect(
      desktopUpdaterEndpoint('dev', 'http://127.0.0.1:18787'),
      'an all-in-one page origin must never become a native updater endpoint',
    ).toBeUndefined()
  })
  it('sets the update channel and persists it', async () => {
    // POD-1882: the mutation answers with the EFFECTIVE fleet default, not a bare
    // string, so the caller learns whether the environment overrode the write.
    expect(await caller().setup.setChannel({ channel: 'edge' })).toMatchObject({
      channel: 'edge',
      envForced: false,
    })
    expect(await caller().setup.channel()).toMatchObject({ channel: 'edge', envForced: false })
    expect(loadConfig().updateChannel).toBe('edge')
  })
})

/**
 * POD-2766 — SETTING A PASSWORD MUST NOT LOOK LIKE A RECONFIGURATION.
 *
 * The incident, end to end and in one place: `setup.complete` carries the login
 * password, so an operator setting one on a live box called it; it back-filled
 * `persistence`, which the running process compares against what it booted with;
 * readiness went `activation_pending`; the data plane closed; and login sits
 * behind the data plane, so the person who could restart it was locked out.
 *
 * These tests run the real command against a real config file and derive real
 * readiness from it — no stubbed diff — because the defect lived exactly in the
 * seam between the two.
 */
describe('a credential change does not trip the topology guard [POD-2766]', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-activation-'))
    process.env.PODIUM_STATE_DIR = dir
    harness = undefined
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    harness = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  /** Readiness for a process that booted with whatever is on disk RIGHT NOW —
   *  the honest way to model "the server was already running when this call
   *  arrived". */
  function readinessAsIfBootedNow() {
    const bootConfig = loadConfig()
    return createServerReadiness({ bootConfig, hasLiveAgentMachine: () => true })
  }

  it('leaves readiness untouched when only the password changes', async () => {
    // A CONTAINER, which is the shape that broke: it runs the binary directly, so
    // its config records no `persistence` — which at config v2 is an ANSWER
    // ("not headless-managed"), not a gap waiting to be filled.
    saveConfig({ mode: 'all-in-one', publicUrl: 'https://sandbox.example.com' })
    const readiness = readinessAsIfBootedNow()
    expect(readiness()).toMatchObject({ state: 'ready', dataPlane: 'available' })

    await caller().setup.complete({
      publicUrl: 'https://sandbox.example.com',
      password: 'operator',
    })

    expect(await verifyPasswordHash('operator', await credentialHash())).toBe(true)
    // THE ASSERTION THIS ISSUE EXISTS FOR.
    expect(readiness()).toMatchObject({ state: 'ready', dataPlane: 'available' })
    // And the reason it holds: the box's own answer about how it is supervised
    // was not overwritten by a call that had nothing to say about it.
    expect(loadConfig().persistence).toBeUndefined()
  })

  it('still records a persistence choice on a genuinely first run', async () => {
    // The back-fill is not deleted, only scoped. A box that has never chosen a
    // mode is choosing everything now, and the web setup cannot self-daemonize —
    // recording the choice for the next `podium` invocation is the whole point.
    await caller().setup.complete({
      publicUrl: 'https://box.ts.net',
      acknowledgeNoPassword: true,
    })
    expect(loadConfig().persistence).toBe('systemd')
  })

  it('still blocks the data plane when a boot-relevant field really changes', async () => {
    // The guard is CORRECT and stays armed. This is the case it exists for: the
    // running process is all-in-one and the file now says server-only.
    saveConfig({ mode: 'all-in-one', publicUrl: 'https://box.ts.net' })
    const readiness = readinessAsIfBootedNow()
    await caller().setup.complete({
      publicUrl: 'https://box.ts.net',
      mode: 'server',
      acknowledgeNoPassword: true,
    })
    expect(readiness()).toMatchObject({
      state: 'activation_pending',
      dataPlane: 'blocked',
      controlPlane: 'available',
      stale: ['mode'],
    })
  })
})

describe('setup.activate — the restart an operator can actually reach [POD-2766]', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-activate-'))
    process.env.PODIUM_STATE_DIR = dir
    harness = undefined
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    harness = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('restarts the process when the instance is activation-pending', async () => {
    const restart = vi.fn()
    const result = await activationHarness({
      readiness: () => pendingOn(['persistence']),
      requestCoordinatorRestart: restart,
    }).setup.activate()
    expect(restart).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ state: 'restarting', stale: ['persistence'] })
  })

  it('refuses on a healthy instance, so it never becomes a remote bounce lever', async () => {
    const restart = vi.fn()
    await expect(
      activationHarness({
        readiness: () => READY,
        requestCoordinatorRestart: restart,
      }).setup.activate(),
    ).rejects.toThrow(/nothing to activate/i)
    expect(restart).not.toHaveBeenCalled()
  })

  it('says so, rather than pretending, when the installation cannot restart itself', async () => {
    await expect(
      activationHarness({ readiness: () => pendingOn(['mode']) }).setup.activate(),
    ).rejects.toThrow(/cannot restart itself/i)
  })

  it('refuses a member: a session must not let anyone drop everyone else transport', () => {
    // The contract's `admin` floor, enforced in the service the way this family
    // enforces everything (see `setLoginRequired`, which verifies the caller's own
    // credential rather than leaning on the router).
    const restart = vi.fn()
    const service = new InstanceService({
      callerUserId: FIRST_ADMIN_USER_ID,
      users: {
        get: () => ({ role: 'member' }),
        credentialFor: () => undefined,
        setPasswordHash: () => {},
      },
      readiness: () => pendingOn(['persistence']),
      requestCoordinatorRestart: restart,
    })
    expect(() => service.activate()).toThrow(/only an admin/i)
    expect(restart).not.toHaveBeenCalled()
  })
})

/**
 * POD-1882. Writing the fleet default is not just a config write: every machine
 * with no pin of its own re-resolves against it. The mutation must therefore not
 * answer — and clients must not be told — until the NEW channel's target has
 * loaded, or the projection ships a new channel beside the old channel's target
 * and nothing ever corrects it.
 */
describe('fleet default channel refresh ordering', () => {
  it('broadcasts only after the new channel target has resolved', async () => {
    const order: string[] = []
    let releaseTarget: (() => void) | undefined
    const refreshTarget = vi.fn(
      (_channel: string) =>
        new Promise<void>((resolve) => {
          order.push('refreshTarget:start')
          releaseTarget = () => {
            order.push('refreshTarget:done')
            resolve()
          }
        }),
    )
    const broadcast = vi.fn(() => {
      order.push('broadcast')
    })

    const service = new InstanceService({
      callerUserId: FIRST_ADMIN_USER_ID,
      onFleetChannelChanged: async (channel) => {
        await refreshTarget(channel)
        broadcast()
      },
    })

    const mutation = service.setChannel('edge')
    await Promise.resolve()

    // The target is still loading, so nothing has been projected yet.
    expect(refreshTarget).toHaveBeenCalledWith('edge')
    expect(broadcast).not.toHaveBeenCalled()

    releaseTarget?.()
    const result = await mutation

    expect(order).toEqual(['refreshTarget:start', 'refreshTarget:done', 'broadcast'])
    expect(result.channel).toBe('edge')
  })

  it('refuses the write when the environment forces the channel', async () => {
    const prior = process.env.PODIUM_UPDATE_CHANNEL
    process.env.PODIUM_UPDATE_CHANNEL = 'dev'
    try {
      const onFleetChannelChanged = vi.fn(async () => {})
      const service = new InstanceService({
        callerUserId: FIRST_ADMIN_USER_ID,
        onFleetChannelChanged,
      })

      expect(service.channel()).toMatchObject({ channel: 'dev', envForced: true })
      await expect(service.setChannel('stable')).rejects.toThrow(/PODIUM_UPDATE_CHANNEL/)
      // A refused write must not have re-broadcast anything either.
      expect(onFleetChannelChanged).not.toHaveBeenCalled()
    } finally {
      if (prior === undefined) delete process.env.PODIUM_UPDATE_CHANNEL
      else process.env.PODIUM_UPDATE_CHANNEL = prior
    }
  })
})

/**
 * ONE provenance surface (PDM-26). The web reads this once and every settings
 * control asks it the same question, instead of a per-key `envForced` boolean
 * growing next to each accessor it can drift from.
 */
describe('instance provenance', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('names a layer for every layered key', () => {
    const provenance = new InstanceService({}).provenance()
    for (const key of LAYERED_KEYS) {
      expect(provenance[key]).toBeDefined()
      expect(['env', 'file', 'default']).toContain(provenance[key].source)
    }
  })

  it('reports env AND the variable to unset when one is set', () => {
    vi.stubEnv('PODIUM_UPDATE_CHANNEL', 'edge')
    vi.stubEnv('PODIUM_MODE', 'server')
    const provenance = new InstanceService({}).provenance()
    expect(provenance.updateChannel).toEqual({ source: 'env', env: 'PODIUM_UPDATE_CHANNEL' })
    expect(provenance.mode).toEqual({ source: 'env', env: 'PODIUM_MODE' })
  })

  it('reports file when config.json answered, and never leaks the value', () => {
    saveConfig({ ...loadConfig(), updateChannel: 'edge' })
    const provenance = new InstanceService({}).provenance()
    expect(provenance.updateChannel).toEqual({ source: 'file' })
  })

  it('channel() derives envForced from provenance and reports the update scope', () => {
    vi.stubEnv('PODIUM_UPDATE_SCOPE', 'fleet-only')
    expect(new InstanceService({}).channel()).toMatchObject({
      envForced: false,
      updateScope: 'fleet-only',
      updateScopeSource: 'env',
    })
  })

  it('refuses setup.connect and setup.join when the environment owns the mode', async () => {
    vi.stubEnv('PODIUM_MODE', 'server')
    const service = new InstanceService({ callerUserId: FIRST_ADMIN_USER_ID })
    // Both refuse BEFORE the remote is asked anything (PDM-34 made them async): a
    // deployment whose mode the environment owns must not even be probed.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(service.connect({ mode: 'all-in-one' })).rejects.toThrow(/PODIUM_MODE/)
    await expect(service.join('anything')).rejects.toThrow(/PODIUM_MODE/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses setup.complete when the environment owns the public URL', async () => {
    vi.stubEnv('PODIUM_PUBLIC_URL', 'https://api.example')
    const service = new InstanceService({ callerUserId: FIRST_ADMIN_USER_ID })
    await expect(
      service.complete({ publicUrl: 'https://other.example', acknowledgeNoPassword: true }),
    ).rejects.toThrow(/PODIUM_PUBLIC_URL/)
  })
})
