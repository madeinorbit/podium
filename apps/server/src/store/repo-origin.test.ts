import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ScanReposResult, SessionRegistry } from '../relay'
import { deriveRepoId } from '../repo-id'
import { RepoRegistry } from '../repo-registry'
import { openTestStore } from '../test-support/open-test-store'

const MACHINE = asMachineId('machine-b')
const SERVER_ORIGIN = 'https://example.test/server/project.git'
const MACHINE_ORIGIN = 'https://example.test/machine-b/project.git'
const registries: SessionRegistry[] = []
const directories: string[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) {
    await registry.dispose()
    await registry.sessionStore.close()
  }
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function world() {
  const path = await mkdtemp(join(tmpdir(), 'podium-repo-origin-'))
  directories.push(path)
  await mkdir(join(path, '.git'))
  await writeFile(join(path, '.git', 'config'), `[remote "origin"]\nurl = ${SERVER_ORIGIN}\n`)
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: MACHINE,
    name: 'Machine B',
    hostname: 'machine-b',
    tokenHash: 'test',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(registry)
  // Drive the later enrichment scan explicitly so its result cannot hide the initial insert.
  vi.spyOn(registry.modules.checkouts, 'rescanSoon').mockImplementation(() => {})
  let response: ScanReposResult = { repositories: [], diagnostics: [] }
  const daemon = vi.fn((message: ControlMessage) => {
    if (message.type === 'scanReposRequest') {
      void registry.gateway.routeDaemonFrame(MACHINE, {
        type: 'scanReposResult',
        requestId: message.requestId,
        ...response,
      })
    }
  })
  await registry.gateway.attachDaemon(MACHINE, daemon)
  daemon.mockClear()
  const repos = new RepoRegistry(registry, store)
  const row = async () => (await store.repos.listRepos(MACHINE)).find((repo) => repo.path === path)
  return {
    path,
    store,
    registry,
    repos,
    daemon,
    row,
    reportOrigin: (reportedPath = path) => {
      response = {
        repositories: [
          { path: reportedPath, kind: 'repository', originUrl: MACHINE_ORIGIN, worktrees: [] },
        ],
        diagnostics: [],
      }
    },
  }
}

describe('repository origins belong to the repository machine', () => {
  it('manual add uses machine B despite a conflicting origin at the same server path', async () => {
    const w = await world()
    w.reportOrigin()
    await w.repos.add(w.repos.serverWriter, w.path, MACHINE)

    expect(w.daemon).toHaveBeenCalledWith({
      type: 'scanReposRequest',
      requestId: expect.any(String),
      roots: [w.path],
      includeHome: false,
      maxDepth: 0,
    })
    expect(await w.row()).toMatchObject({
      originUrl: MACHINE_ORIGIN,
      repoId: deriveRepoId({ originUrl: MACHINE_ORIGIN, machineId: MACHINE, path: w.path }),
    })
    expect((await w.row())?.repoId).not.toBe(
      deriveRepoId({ originUrl: SERVER_ORIGIN, machineId: MACHINE, path: w.path }),
    )
  })

  it('a failed manual lookup inserts no origin and a later scan upgrades it through updateRepoOrigin', async () => {
    const w = await world()
    const scan = vi
      .spyOn(w.registry.modules.rpc, 'scanRepos')
      .mockRejectedValueOnce(new Error('daemon disconnected'))
    await w.repos.add(w.repos.serverWriter, w.path, MACHINE)
    expect(await w.row()).toMatchObject({
      originUrl: null,
      repoId: deriveRepoId({ machineId: MACHINE, path: w.path }),
    })
    scan.mockRestore()

    const update = vi.spyOn(w.store.repos, 'updateRepoOrigin')
    w.reportOrigin()
    await w.registry.modules.checkouts.rescan(MACHINE)
    expect(update).toHaveBeenCalledWith(MACHINE, w.path, MACHINE_ORIGIN)
    expect(await w.row()).toMatchObject({
      originUrl: MACHINE_ORIGIN,
      repoId: deriveRepoId({ originUrl: MACHINE_ORIGIN, machineId: MACHINE, path: w.path }),
    })
  })

  it('an offline machine registers immediately without a daemon request or server origin', async () => {
    const w = await world()
    w.registry.modules.machines.detach(MACHINE, w.daemon)
    const scan = vi.spyOn(w.registry.modules.rpc, 'scanRepos')
    await w.repos.add(w.repos.serverWriter, w.path, MACHINE)
    expect(scan).not.toHaveBeenCalled()
    expect(await w.row()).toMatchObject({
      originUrl: null,
      repoId: deriveRepoId({ machineId: MACHINE, path: w.path }),
    })
  })

  it('an empty or unrelated scan result never borrows another repository origin', async () => {
    const w = await world()
    w.reportOrigin(`${w.path}-other`)
    await w.repos.add(w.repos.serverWriter, w.path, MACHINE)
    expect(await w.row()).toMatchObject({
      originUrl: null,
      repoId: deriveRepoId({ machineId: MACHINE, path: w.path }),
    })
  })

  it('the store accepts only its origin argument, even when that path exists on the server', async () => {
    const w = await world()
    await w.store.repos.addRepo(w.path, MACHINE)
    expect(await w.row()).toMatchObject({
      originUrl: null,
      repoId: deriveRepoId({ machineId: MACHINE, path: w.path }),
    })
    expect(w.daemon).not.toHaveBeenCalled()
  })
})
