import { firstAdminMemberId } from '@podium/model'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { browseDirectories, RepoRegistry } from './repo-registry'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

/** A RepoRegistry whose registry shares the given store and has one online machine,
 *  so single-machine add/remove attribute to that machine — preserving the original
 *  single-store behavior these tests assert. */
async function singleMachineRepos(store: SessionStore): Promise<RepoRegistry> {
  await store.machines.upsertMachine({
    id: store.hostMachineId, name: 'repo-test', hostname: 'repo-test', tokenHash: 'repo-test',
    ownerUserId: firstAdminMemberId(), assignment: { server: true, agentExecution: true },
  })
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
  return new RepoRegistry(registry, store)
}

describe('RepoRegistry', () => {
  it('starts empty, adds, dedupes, lists, removes', async () => {
    const reg = await singleMachineRepos(await openTestStore(':memory:'))
    expect(await reg.list()).toEqual([])
    await reg.add('/home/u/src/app', undefined, undefined, () => 'granted')
    await reg.add('/home/u/src/app', undefined, undefined, () => 'granted') // dedupe
    expect(await reg.list()).toEqual(['/home/u/src/app'])
    await reg.remove('/home/u/src/app', undefined, () => 'granted')
    expect(await reg.list()).toEqual([])
  })

  it('refuses omitted targets without use authorization for every repository write', async () => {
    const reg = await singleMachineRepos(await openTestStore(':memory:'))
    await expect(reg.add('/repo')).rejects.toThrow('use')
    await reg.add('/repo', undefined, undefined, () => 'granted')
    await expect(reg.setPrefix('/repo', 'DENY', undefined, () => 'denied')).rejects.toThrow('use')
    await expect(reg.remove('/repo', undefined, () => 'denied')).rejects.toThrow('use')
    expect(await reg.list()).toEqual(['/repo'])
    await reg.remove('/repo', undefined, () => 'granted')
    expect(await reg.list()).toEqual([])
  })

  it('rejects non-absolute and empty paths', async () => {
    const reg = await singleMachineRepos(await openTestStore(':memory:'))
    await expect(reg.add('')).rejects.toThrow()
    await expect(reg.add('relative/path')).rejects.toThrow()
  })

  it('persists across instances on the same db file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-reporeg-'))
    const file = join(dir, 'podium.db')
    const a = await singleMachineRepos(await openTestStore(file))
    await a.add('/abs/one', undefined, undefined, () => 'granted')
    const b = await singleMachineRepos(await openTestStore(file))
    expect(await b.list()).toEqual(['/abs/one'])
  })

  it('inferFromPath returns the longest matching registered root', async () => {
    const repos = await singleMachineRepos(await openTestStore(':memory:'))
    await repos.add('/a', undefined, undefined, () => 'granted')
    await repos.add('/a/b', undefined, undefined, () => 'granted')
    expect(await repos.inferFromPath('/a/b/x/y')).toBe('/a/b')
    expect(await repos.inferFromPath('/a/x')).toBe('/a')
    expect(await repos.inferFromPath('/a')).toBe('/a')
    expect(await repos.inferFromPath('/ab')).toBeUndefined()
    expect(await repos.inferFromPath('/elsewhere')).toBeUndefined()
  })

  it('browses server-side directories from HOME by default', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-browse-home-'))
    await mkdir(join(home, 'src'), { recursive: true })
    await mkdir(join(home, 'notes'), { recursive: true })
    await mkdir(join(home, '.cache'), { recursive: true })

    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const listing = await browseDirectories()
      expect(listing.path).toBe(home)
      expect(listing.entries.map((entry) => entry.name)).toEqual(['notes', 'src'])
      const withHidden = await browseDirectories(undefined, { includeHidden: true })
      expect(withHidden.entries.map((entry) => entry.name)).toEqual(['.cache', 'notes', 'src'])
    } finally {
      process.env.HOME = prevHome
    }
  })
})
