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
    await reg.add(reg.serverWriter, '/home/u/src/app')
    await reg.add(reg.serverWriter, '/home/u/src/app') // dedupe
    expect(await reg.list()).toEqual(['/home/u/src/app'])
    await reg.remove(reg.serverWriter, '/home/u/src/app')
    expect(await reg.list()).toEqual([])
  })

  it('rejects non-absolute and empty paths', async () => {
    const reg = await singleMachineRepos(await openTestStore(':memory:'))
    await expect(reg.add(reg.serverWriter, '')).rejects.toThrow()
    await expect(reg.add(reg.serverWriter, 'relative/path')).rejects.toThrow()
  })

  it('persists across instances on the same db file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-reporeg-'))
    const file = join(dir, 'podium.db')
    const a = await singleMachineRepos(await openTestStore(file))
    await a.add(a.serverWriter, '/abs/one')
    const b = await singleMachineRepos(await openTestStore(file))
    expect(await b.list()).toEqual(['/abs/one'])
  })

  it('inferFromPath returns the longest matching registered root', async () => {
    const repos = await singleMachineRepos(await openTestStore(':memory:'))
    await repos.add(repos.serverWriter, '/a')
    await repos.add(repos.serverWriter, '/a/b')
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

// POD-6246: the logical repo row (its chosen root and its name) is a function
// of the registered checkouts and their remotes, so it is republished when a
// checkout leaves. (A scan's new remote is the checkouts service's to record,
// `modules/checkouts/service.test.ts`, POD-6644.)
describe('republishing the logical repo row', () => {
  const machineId = asMachineId('mac')
  const root = '/Users/mw/Source/other/bak_podium'
  const origin = 'git@github.com:madeinorbit/podium.git'
  const make = (stored: string | null, scanned: { path: string; originUrl?: string }[]) => {
    const published: number[] = []
    const updates: string[] = []
    const row = {
      machineId,
      path: root,
      repoId: asRepoId('repo-podium'),
      prefix: 'POD',
      originUrl: stored,
    }
    const registry = new RepoRegistry(
      {
        modules: {
          machines: { onlineMachineIds: () => [machineId], defaultMachine: async () => machineId },
          checkouts: { registrationsChanged: async () => {}, rescanSoon: () => {} },
          rpc: {
            scanRepos: async () => ({
              repositories: scanned.map((r) => ({ ...r, kind: 'repository', worktrees: [] })),
              diagnostics: [],
            }),
          },
          issues: {
            reports: {
              store: {
                publishRepos: async () => void published.push(1),
                commitRepoWrite: async <T>(_writer: unknown, write: () => Promise<T>) => {
                  const value = await write()
                  published.push(1)
                  return value
                },
              },
            },
          },
        },
      } as unknown as SessionRegistry,
      {
        repos: {
          listRepos: async () => [row],
          listRepoPaths: async () => [root],
          updateRepoOrigin: async (_m: string, path: string, url: string) =>
            void updates.push(`${path} ${url}`),
          removeRepo: async () => {},
        },
      } as unknown as SessionStore,
    )
    return { registry, published, updates }
  }

  it('publishes when a checkout is removed', async () => {
    const { registry, published } = make(origin, [])
    await registry.remove(registry.serverWriter, root, machineId)
    expect(published).toHaveLength(1)
  })
})
