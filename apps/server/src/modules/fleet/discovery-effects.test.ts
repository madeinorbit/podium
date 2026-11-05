/**
 * SCANS AND CLONES AS EFFECT RECORDS (POD-6396).
 *
 * Through the composed server: the old routes create `folder.scan`,
 * `machine.scan` and `repo.clone` records, the executors talk to the daemon
 * through its RPC (stubbed here: the one boundary these tests do not cross),
 * and the routes answer as before. The machine's last scan is its newest
 * succeeded record.
 */

import type { GitRepositoryWire } from '@podium/model'
import { asMachineId, mintDeviceId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EffectsRunner } from '../effects/runner'
import type { ScanReposResult } from '../machines/rpc'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { changeRows } from '../sync-write/outbox-test-support'
import {
  connectScanThroughEffect,
  FOLDER_SCAN_KIND,
  GITHUB_CLI_TIMEOUT,
  MACHINE_SCAN_KIND,
  MAX_KEPT,
  REPO_CLONE_KIND,
} from './discovery-effects'

afterEach(() => {
  vi.restoreAllMocks()
  return disposeOracles()
})

const rpc = (o: Oracle) => o.reg.modules.rpc

const repo = (path: string, originUrl?: string): GitRepositoryWire => ({
  path,
  kind: 'repository',
  worktrees: [],
  ...(originUrl ? { originUrl } : {}),
})

const scanned = (repositories: GitRepositoryWire[]): ScanReposResult => ({
  repositories,
  diagnostics: [],
})

const READY = { state: 'ready' as const, login: 'mike' }

async function records(o: Oracle) {
  const ids = [
    ...new Set(
      (await changeRows(o)).filter((row) => row.entity === 'effect').map((row) => row.entityId),
    ),
  ]
  return await Promise.all(ids.map(async (id) => await o.store.effects.get(id)))
}

async function stoppedRunner(o: Oracle) {
  const effects = o.reg.modules.effects
  if (effects === undefined) throw new Error('no effects module')
  await effects.runner.stop()
  return {
    effects,
    sweep: async () => {
      const runner = new EffectsRunner({
        repo: o.store.effects,
        registry: effects.executors,
        now: Date.now,
        every: () => () => undefined,
      })
      await runner.sweep()
      await runner.idle()
    },
  }
}

async function leftRunning(o: Oracle, kind: string, input: unknown): Promise<string> {
  const id = mintDeviceId('eff_')
  await o.store.effects.insert(
    {
      id,
      kind,
      target: { kind: 'machine', id: o.store.hostMachineId },
      input,
      deadlineAt: Date.now() + 60_000,
      createdBy: null,
    },
    Date.now(),
  )
  await o.store.effects.claim(id, Date.now())
  return id
}

describe('discovery.scanFolder runs as a folder.scan record', () => {
  it('answers the scan, and the record holds it on the machine it scanned', async () => {
    const o = await makeOracle()
    const scan = vi.spyOn(rpc(o), 'scanRepos').mockResolvedValue(scanned([repo('/src/a')]))
    const answer = await o.call.discovery.scanFolder({ path: '/src' })
    expect(answer).toEqual(scanned([repo('/src/a')]))
    expect(scan).toHaveBeenCalledWith(
      ['/src'],
      { includeHome: false, maxDepth: 6 },
      o.store.hostMachineId,
    )
    const [record] = await records(o)
    expect([record?.kind, record?.status]).toEqual([FOLDER_SCAN_KIND, 'succeeded'])
    expect(record?.target).toEqual({ kind: 'machine', id: o.store.hostMachineId })
    expect(record?.input).toEqual({ path: '/src' })
  })

  it('keeps a bounded result and says what it left out', async () => {
    const o = await makeOracle()
    const many = Array.from({ length: MAX_KEPT + 7 }, (_, i) => repo(`/src/r${i}`))
    vi.spyOn(rpc(o), 'scanRepos').mockResolvedValue(scanned(many))
    const answer = await o.call.discovery.scanFolder({ path: '/src' })
    expect(answer.repositories).toHaveLength(MAX_KEPT)
    expect(answer.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('7 more') }),
    ])
  })
})

describe('discovery.scanMachine runs as a machine.scan record', () => {
  it('auto-registers origin matches, and the record is the last scan of that machine', async () => {
    const other = asMachineId('other-box')
    const o = await makeOracle({ offlineMachines: [{ id: other, name: 'other' }] })
    await o.store.repos.addRepo('/home/u/src/x', other, 'git@github.com:o/x.git')
    vi.spyOn(rpc(o), 'scanRepos').mockImplementation(async (roots) =>
      roots.includes('/home/u/src/x')
        ? scanned([repo('/home/u/src/x', 'https://github.com/o/x.git')])
        : scanned([]),
    )
    const host = o.store.hostMachineId
    expect(await o.call.discovery.lastMachineScan({ machineId: host })).toBeNull()
    const answer = await o.call.discovery.scanMachine({ machineId: host, deep: false })
    expect(answer.repos).toEqual([
      expect.objectContaining({ path: '/home/u/src/x', status: 'auto-registered' }),
    ])
    expect((await o.store.repos.listRepos(host)).map((r) => r.path)).toContain('/home/u/src/x')
    expect(await o.call.discovery.lastMachineScan({ machineId: host })).toEqual(answer)
    const [record] = await records(o)
    expect([record?.kind, record?.status]).toEqual([MACHINE_SCAN_KIND, 'succeeded'])
  })

  it('a second ask for the same scan joins the one running there', async () => {
    const o = await makeOracle()
    let release: (r: ScanReposResult) => void = () => {}
    const gate = new Promise<ScanReposResult>((resolve) => {
      release = resolve
    })
    const scan = vi.spyOn(rpc(o), 'scanRepos').mockImplementation(async () => await gate)
    const host = o.store.hostMachineId
    const first = o.call.discovery.scanMachine({ machineId: host, deep: true })
    await vi.waitFor(() => expect(scan).toHaveBeenCalled())
    const second = o.call.discovery.scanMachine({ machineId: host, deep: true })
    // A different scan of the same machine does not join.
    const other = o.call.discovery.scanMachine({ machineId: host, deep: true, atPath: '/a' })
    await vi.waitFor(async () => expect(await records(o)).toHaveLength(2))
    release(scanned([]))
    const [a, b] = await Promise.all([first, second, other])
    expect(b).toEqual(a)
    expect(await records(o)).toHaveLength(2)
  })

  it("the server's connect scan is a record with no creator, read as the last scan", async () => {
    const o = await makeOracle()
    vi.spyOn(rpc(o), 'scanRepos').mockResolvedValue(scanned([]))
    const host = o.store.hostMachineId
    await connectScanThroughEffect(o.reg.modules, host)
    const [record] = await records(o)
    expect([record?.kind, record?.status, record?.createdBy]).toEqual([
      MACHINE_SCAN_KIND,
      'succeeded',
      null,
    ])
    expect(record?.actor).toBe('system:repo-discovery.connect-scan')
    expect(await o.call.discovery.lastMachineScan({ machineId: host })).toMatchObject({
      machineId: host,
      deep: false,
    })
  })

  it('a scan left running by a stopped server fails as interrupted, never re-run', async () => {
    const o = await makeOracle()
    const { sweep } = await stoppedRunner(o)
    const id = await leftRunning(o, MACHINE_SCAN_KIND, { deep: true })
    const scan = vi.spyOn(rpc(o), 'scanRepos')
    await sweep()
    const row = await o.store.effects.get(id)
    expect([row?.status, row?.error?.code]).toEqual(['failed', 'interrupted'])
    expect(scan).not.toHaveBeenCalled()
  })
})

describe('repos.cloneGithub runs as a repo.clone record', () => {
  const input = (o: Oracle) => ({
    machineId: o.store.hostMachineId,
    repository: 'octo/app',
    destination: '/src/app',
  })

  it('clones, registers the checkout with its origin, and answers as before', async () => {
    const o = await makeOracle()
    vi.spyOn(rpc(o), 'scanRepos').mockResolvedValue(scanned([]))
    const clone = vi
      .spyOn(rpc(o), 'githubCli')
      .mockResolvedValue({ status: READY, path: '/src/app' })
    const answer = await o.call.repos.cloneGithub(input(o))
    expect(clone).toHaveBeenCalledWith('clone', o.store.hostMachineId, {
      repository: 'octo/app',
      destination: '/src/app',
    })
    expect(answer.path).toBe('/src/app')
    expect(answer.repos).toContain('/src/app')
    const registered = await o.store.repos.listRepos(o.store.hostMachineId)
    expect(registered.find((r) => r.path === '/src/app')?.originUrl).toBe(
      'https://github.com/octo/app.git',
    )
    const [record] = await records(o)
    expect([record?.kind, record?.status]).toEqual([REPO_CLONE_KIND, 'succeeded'])
  })

  it("the GitHub CLI's refusal answers as the precondition it always was", async () => {
    const o = await makeOracle()
    vi.spyOn(rpc(o), 'scanRepos').mockResolvedValue(scanned([]))
    vi.spyOn(rpc(o), 'githubCli').mockResolvedValue({ status: { state: 'logged-out' } })
    await expect(o.call.repos.cloneGithub(input(o))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub CLI is not signed in on this machine',
    })
    const [record] = await records(o)
    expect([record?.status, record?.error?.code]).toEqual(['failed', 'clone'])
  })

  it('a timed-out clone is checked: a checkout of that repository there is registered', async () => {
    const o = await makeOracle()
    const probe = vi
      .spyOn(rpc(o), 'scanRepos')
      .mockResolvedValueOnce(scanned([]))
      .mockResolvedValue(scanned([repo('/src/app', 'git@github.com:octo/app.git')]))
    vi.spyOn(rpc(o), 'githubCli').mockResolvedValue({
      status: { state: 'logged-out' },
      error: GITHUB_CLI_TIMEOUT,
    })
    expect((await o.call.repos.cloneGithub(input(o))).path).toBe('/src/app')
    expect(probe).toHaveBeenLastCalledWith(
      ['/src/app'],
      { includeHome: false, maxDepth: 0 },
      o.store.hostMachineId,
    )
    expect((await o.store.repos.listRepos(o.store.hostMachineId)).map((r) => r.path)).toContain(
      '/src/app',
    )
  })

  it('a checkout of another repository at the destination is not taken for the clone', async () => {
    const o = await makeOracle()
    vi.spyOn(rpc(o), 'scanRepos').mockResolvedValue(
      scanned([repo('/src/app', 'https://github.com/someone/else.git')]),
    )
    vi.spyOn(rpc(o), 'githubCli').mockResolvedValue({
      status: { state: 'logged-out' },
      error: GITHUB_CLI_TIMEOUT,
    })
    await expect(o.call.repos.cloneGithub(input(o))).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    })
    const [record] = await records(o)
    expect([record?.status, record?.error?.code]).toEqual(['unknown', 'lost-track'])
    expect((await o.store.repos.listRepos(o.store.hostMachineId)).map((r) => r.path)).not.toContain(
      '/src/app',
    )
  })

  it('a clone left running by a stopped server is registered when the checkout is there', async () => {
    const o = await makeOracle()
    const { sweep } = await stoppedRunner(o)
    const id = await leftRunning(o, REPO_CLONE_KIND, {
      repository: 'octo/app',
      destination: '/src/app',
    })
    vi.spyOn(rpc(o), 'scanRepos').mockResolvedValue(
      scanned([repo('/src/app', 'https://github.com/octo/app.git')]),
    )
    const clone = vi.spyOn(rpc(o), 'githubCli')
    await sweep()
    const row = await o.store.effects.get(id)
    expect(row?.status).toBe('succeeded')
    expect(row?.result).toEqual({ path: '/src/app' })
    expect((await o.store.repos.listRepos(o.store.hostMachineId)).map((r) => r.path)).toContain(
      '/src/app',
    )
    // Checked, never cloned again.
    expect(clone).not.toHaveBeenCalled()
  })

  it('a clone left running with nothing at the destination is unknown', async () => {
    const o = await makeOracle()
    const { sweep } = await stoppedRunner(o)
    const id = await leftRunning(o, REPO_CLONE_KIND, {
      repository: 'octo/app',
      destination: '/src/app',
    })
    vi.spyOn(rpc(o), 'scanRepos').mockResolvedValue(scanned([]))
    await sweep()
    expect((await o.store.effects.get(id))?.status).toBe('unknown')
  })
})
