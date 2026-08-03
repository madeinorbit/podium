import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { loadConfig } from '@podium/runtime/config'
import { encodeJoin } from '@podium/runtime/join'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'

import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
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
    expect(await caller().setup.channel()).toBe('stable')
  })
  it('sets the update channel and persists it', async () => {
    expect(await caller().setup.setChannel({ channel: 'edge' })).toBe('edge')
    expect(await caller().setup.channel()).toBe('edge')
    expect(loadConfig().updateChannel).toBe('edge')
  })
})
