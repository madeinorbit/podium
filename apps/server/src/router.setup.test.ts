import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@podium/core/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SuperagentService } from './superagent'

function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon('local', () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry, repos, registry.sessionStore)
  return appRouter.createCaller({ registry, repos, superagent, role: 'maintainer' })
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
  it('persists a normalized publicUrl + all-in-one mode', async () => {
    await caller().setup.complete({ publicUrl: 'https://box.ts.net/' })
    expect(loadConfig().publicUrl).toBe('https://box.ts.net')
    expect(loadConfig().mode).toBe('all-in-one')
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
