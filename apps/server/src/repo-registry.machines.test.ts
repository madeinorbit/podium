import { asMachineId, firstAdminMemberId } from '@podium/model'
/**
 * Task 9: per-machine repo registration. (The machine-tagged scans are the
 * checkouts service's since POD-6644: `modules/checkouts/service.test.ts`.)
 */
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { attachDaemonWithInventory, fixtureInventory } from './test-support/daemon-inventory'
import { openTestStore } from './test-support/open-test-store'

async function regWithTwoDaemons() {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: 'm1',
    name: 'one',
    hostname: 'one',
    tokenHash: 'x',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  await store.machines.upsertMachine({
    id: 'm2',
    name: 'two',
    hostname: 'two',
    tokenHash: 'y',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const repos = new RepoRegistry(reg, store)
  vi.spyOn(reg.modules.rpc, 'scanRepos').mockResolvedValue({ repositories: [], diagnostics: [] })
  const m1Out: ControlMessage[] = []
  const m2Out: ControlMessage[] = []
  await reg.gateway.attachDaemon('m1', (msg) => m1Out.push(msg))
  await reg.gateway.attachDaemon('m2', (msg) => m2Out.push(msg))
  return { reg, repos, store, m1Out, m2Out }
}

describe('RepoRegistry.list(machineId)', () => {
  it('filters repos by machine', async () => {
    const { repos } = await regWithTwoDaemons()
    await repos.add(repos.serverWriter, '/a', asMachineId('m1'))
    await repos.add(repos.serverWriter, '/b', asMachineId('m2'))
    const m1Repos = await repos.list(asMachineId('m1'))
    const m2Repos = await repos.list(asMachineId('m2'))
    expect(m1Repos).toContain('/a')
    expect(m1Repos).not.toContain('/b')
    expect(m2Repos).toContain('/b')
    expect(m2Repos).not.toContain('/a')
  })

  it('list() with no machineId returns all repos', async () => {
    const { repos } = await regWithTwoDaemons()
    await repos.add(repos.serverWriter, '/a', asMachineId('m1'))
    await repos.add(repos.serverWriter, '/b', asMachineId('m2'))
    const all = await repos.list()
    expect(all).toContain('/a')
    expect(all).toContain('/b')
  })

  it('remove(path, machineId) removes the right machine repo', async () => {
    const { repos } = await regWithTwoDaemons()
    await repos.add(repos.serverWriter, '/a', asMachineId('m1'))
    await repos.add(repos.serverWriter, '/a', asMachineId('m2')) // same path, different machine
    await repos.remove(repos.serverWriter, '/a', asMachineId('m1'))
    expect(await repos.list(asMachineId('m1'))).not.toContain('/a')
    expect(await repos.list(asMachineId('m2'))).toContain('/a')
  })
})

// POD-7501: the path helpers read a path's syntax from its spelling, so a POSIX
// spelling on a Windows machine keeps `\` literal while the machine splits on it.
describe('repo registration checks the path syntax against the machine OS', () => {
  async function regWithOs(os: 'linux' | 'win32') {
    const { reg, repos } = await regWithTwoDaemons()
    await attachDaemonWithInventory(reg, 'm1', () => {}, fixtureInventory({ os }))
    return { repos, m1: asMachineId('m1') }
  }

  it('refuses a POSIX-spelled repo on a Windows machine and keeps a Windows one', async () => {
    const { repos, m1 } = await regWithOs('win32')
    for (const path of ['/c/Users/a/repo', '//nas/share/repo']) {
      await expect(repos.add(repos.serverWriter, path, m1)).rejects.toThrow(
        /must be a Windows path .* on one/,
      )
    }
    await repos.add(repos.serverWriter, 'C:\\Users\\a\\repo', m1)
    await repos.add(repos.serverWriter, '\\\\nas\\share\\repo', m1)
    expect(await repos.list(m1)).toEqual(
      expect.arrayContaining(['C:\\Users\\a\\repo', '\\\\nas\\share\\repo']),
    )
    expect(await repos.list(m1)).not.toContain('/c/Users/a/repo')
  })

  it('refuses a Windows-spelled repo on a POSIX machine', async () => {
    const { repos, m1 } = await regWithOs('linux')
    await expect(repos.add(repos.serverWriter, 'C:\\Users\\a\\repo', m1)).rejects.toThrow(
      /must be a POSIX path .* on one/,
    )
    await repos.add(repos.serverWriter, '/home/a/repo', m1)
    expect(await repos.list(m1)).toContain('/home/a/repo')
  })

  it('a machine that has not reported its OS is left to the daemon check', async () => {
    const { repos } = await regWithTwoDaemons()
    await repos.add(repos.serverWriter, 'C:\\Users\\a\\repo', asMachineId('m2'))
    expect(await repos.list(asMachineId('m2'))).toContain('C:\\Users\\a\\repo')
  })
})
