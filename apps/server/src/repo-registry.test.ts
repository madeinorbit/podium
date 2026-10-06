import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asRepoId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { browseDirectories, inferRepoFromRoots, RepoRegistry } from './repo-registry'
import type { SessionStore } from './store'
import { normalizeRepoPath } from './store'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

/** A RepoRegistry whose registry shares the given store and has one online machine,
 *  so single-machine add/remove attribute to that machine — preserving the original
 *  single-store behavior these tests assert. */
async function singleMachineRepos(store: SessionStore): Promise<RepoRegistry> {
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(registry, () => {})
  return new RepoRegistry(registry, store)
}

describe('RepoRegistry', () => {
  it('starts empty, adds, dedupes, lists, removes', async () => {
    const reg = await singleMachineRepos(await openTestStore(':memory:'))
    expect(await reg.list()).toEqual([])
    await reg.add('/home/u/src/app')
    await reg.add('/home/u/src/app') // dedupe
    expect(await reg.list()).toEqual(['/home/u/src/app'])
    await reg.remove('/home/u/src/app')
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
    await a.add('/abs/one')
    const b = await singleMachineRepos(await openTestStore(file))
    expect(await b.list()).toEqual(['/abs/one'])
  })

  it('inferFromPath returns the longest matching registered root', async () => {
    const repos = await singleMachineRepos(await openTestStore(':memory:'))
    await repos.add('/a')
    await repos.add('/a/b')
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


it.each([
  ['/repo', '/repo/wt', '/repo/wt/src', '/repository'],
  ['C:\\repo', 'C:\\repo\\wt', 'c:/REPO/wt/src', 'C:\\repository'],
])('machine paths: infer the deepest repository root for %s', (root, nested, cwd, sibling) => {
  expect(inferRepoFromRoots([root, nested], cwd)).toBe(normalizeRepoPath(nested))
  expect(inferRepoFromRoots([root], sibling)).toBeUndefined()
})


it('machine paths: repo scan matches case-folded keys without rewriting display paths', async () => {
  const machineId = asMachineId('windows-scan')
  const root = String.raw`C:\Src\Podium`
  const repoId = asRepoId('repo-stored')
  const row = { machineId, path: root, repoId, prefix: null, originUrl: null }
  const registry = new RepoRegistry({ modules: {
    machines: { onlineMachineIds: () => [machineId] },
    rpc: { scanRepos: async () => ({ repositories: [{ path: 'c:/src/podium', kind: 'repository', worktrees: [] }], diagnostics: [] }) },
  } } as unknown as SessionRegistry, { repos: { listRepos: async () => [row], listRepoPaths: async () => [root] } } as unknown as SessionStore)
  const result = await registry.scanReposAll()
  expect(result.repositories).toEqual([expect.objectContaining({ path: 'c:/src/podium', repoId })])
})
