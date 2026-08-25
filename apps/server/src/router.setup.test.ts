import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIRST_ADMIN_USER_ID, type ServerReadiness } from '@podium/model'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { encodeJoin } from '@podium/runtime/join'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstanceService } from './modules/instance/service'
import { resolvePrincipal } from './command-principal'

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
  const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
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
  const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
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
function credentialHash(): string {
  harness ??= makeHarness()
  return harness.users.credentialFor(FIRST_ADMIN_USER_ID)?.passwordHash ?? ''
}

async function seedPassword(password: string): Promise<void> {
  harness ??= makeHarness()
  harness.users.setPasswordHash(
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
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    harness = undefined
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
    expect(await caller().setup.info()).toEqual({
      mode: null,
      publicUrl: null,
      serverUrl: null,
      appVersion,
    })
    await caller().setup.complete({ publicUrl: 'https://box.ts.net', acknowledgeNoPassword: true })
    expect(await caller().setup.info()).toEqual({
      mode: 'all-in-one',
      publicUrl: 'https://box.ts.net',
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
    expect(await verifyPasswordHash('launch-code', credentialHash())).toBe(true)
  })
  it('rejects a reachable setup without password acknowledgement', async () => {
    await expect(caller().setup.complete({ publicUrl: 'https://box.ts.net' })).rejects.toThrow()
    expect(credentialHash()).toBe('')
  })
  it('keeps an existing password when the URL is set later (no re-ack needed)', async () => {
    await seedPassword('already-set')
    // No password + no ack must NOT throw once one is already configured — it's "keep current".
    await caller().setup.complete({ publicUrl: 'https://relay.ts.net' })
    expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
    expect(await verifyPasswordHash('already-set', credentialHash())).toBe(true) // unchanged
  })
  it('leaves auth open when no password is explicitly acknowledged', async () => {
    await caller().setup.complete({
      publicUrl: 'https://box.ts.net',
      acknowledgeNoPassword: true,
    })
    expect(credentialHash()).toBe('')
  })
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
  it('reports the update channel (default stable)', async () => {
    expect(await caller().setup.channel()).toMatchObject({ channel: 'stable', envForced: false })
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

    expect(await verifyPasswordHash('operator', credentialHash())).toBe(true)
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
      activationHarness({ readiness: () => READY, requestCoordinatorRestart: restart }).setup.activate(),
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
