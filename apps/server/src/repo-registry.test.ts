import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { browseDirectories, RepoRegistry } from './repo-registry'
import { SessionStore } from './store'

/** A RepoRegistry whose registry shares the given store and has one online machine,
 *  so single-machine add/remove attribute to that machine — preserving the original
 *  single-store behavior these tests assert. */
function singleMachineRepos(store: SessionStore): RepoRegistry {
  const registry = new SessionRegistry(store)
  registry.attachDaemon('local', () => {})
  return new RepoRegistry(registry, store)
}

describe('RepoRegistry', () => {
  it('starts empty, adds, dedupes, lists, removes', async () => {
    const reg = singleMachineRepos(new SessionStore(':memory:'))
    expect(reg.list()).toEqual([])
    await reg.add('/home/u/src/app')
    await reg.add('/home/u/src/app') // dedupe
    expect(reg.list()).toEqual(['/home/u/src/app'])
    await reg.remove('/home/u/src/app')
    expect(reg.list()).toEqual([])
  })

  it('rejects non-absolute and empty paths', async () => {
    const reg = singleMachineRepos(new SessionStore(':memory:'))
    await expect(reg.add('')).rejects.toThrow()
    await expect(reg.add('relative/path')).rejects.toThrow()
  })

  it('persists across instances on the same db file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-reporeg-'))
    const file = join(dir, 'podium.db')
    const a = singleMachineRepos(new SessionStore(file))
    await a.add('/abs/one')
    const b = singleMachineRepos(new SessionStore(file))
    expect(b.list()).toEqual(['/abs/one'])
  })

  it('inferFromPath returns the longest matching registered root', async () => {
    const repos = singleMachineRepos(new SessionStore(':memory:'))
    await repos.add('/a')
    await repos.add('/a/b')
    expect(repos.inferFromPath('/a/b/x/y')).toBe('/a/b')
    expect(repos.inferFromPath('/a/x')).toBe('/a')
    expect(repos.inferFromPath('/a')).toBe('/a')
    expect(repos.inferFromPath('/ab')).toBeUndefined()
    expect(repos.inferFromPath('/elsewhere')).toBeUndefined()
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
