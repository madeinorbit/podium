import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@podium/core/config'
import { encodeJoin } from '@podium/core/join'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasPassword, setPassword, verifyPassword } from './auth-store'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SuperagentService } from './superagent'

function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon('local', () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry, repos, registry.sessionStore)
  return appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR })
}

describe('setup tRPC', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setuprtr-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
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
    expect(hasPassword(dir)).toBe(true)
    expect(await verifyPassword('launch-code', dir)).toBe(true)
  })
  it('rejects a reachable setup without password acknowledgement', async () => {
    await expect(caller().setup.complete({ publicUrl: 'https://box.ts.net' })).rejects.toThrow()
    expect(hasPassword(dir)).toBe(false)
  })
  it('keeps an existing password when the URL is set later (no re-ack needed)', async () => {
    await setPassword('already-set', dir)
    // No password + no ack must NOT throw once one is already configured — it's "keep current".
    await caller().setup.complete({ publicUrl: 'https://relay.ts.net' })
    expect(loadConfig().publicUrl).toBe('https://relay.ts.net')
    expect(await verifyPassword('already-set', dir)).toBe(true) // unchanged
  })
  it('leaves auth open when no password is explicitly acknowledged', async () => {
    await caller().setup.complete({
      publicUrl: 'https://box.ts.net',
      acknowledgeNoPassword: true,
    })
    expect(hasPassword(dir)).toBe(false)
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
