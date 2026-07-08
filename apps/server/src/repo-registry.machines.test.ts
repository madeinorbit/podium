/**
 * Task 9: per-machine repo registration + machine-tagged repo scans.
 *
 * TDD red → green tests:
 *  1. list(machineId) filters by machine.
 *  2. scanReposAll() fans out to each online daemon and stamps each repo with its machineId.
 */
import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { SessionStore } from './store'

function regWithTwoDaemons() {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'm1', name: 'one', hostname: 'one', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'm2', name: 'two', hostname: 'two', tokenHash: 'y' })
  const reg = new SessionRegistry(store)
  const repos = new RepoRegistry(reg, store)
  const m1Out: ControlMessage[] = []
  const m2Out: ControlMessage[] = []
  reg.attachDaemon('m1', (msg) => m1Out.push(msg))
  reg.attachDaemon('m2', (msg) => m2Out.push(msg))
  return { reg, repos, store, m1Out, m2Out }
}

describe('RepoRegistry.list(machineId)', () => {
  it('filters repos by machine', async () => {
    const { repos } = regWithTwoDaemons()
    await repos.add('/a', 'm1')
    await repos.add('/b', 'm2')
    const m1Repos = repos.list('m1')
    const m2Repos = repos.list('m2')
    expect(m1Repos).toContain('/a')
    expect(m1Repos).not.toContain('/b')
    expect(m2Repos).toContain('/b')
    expect(m2Repos).not.toContain('/a')
  })

  it('list() with no machineId returns all repos', async () => {
    const { repos } = regWithTwoDaemons()
    await repos.add('/a', 'm1')
    await repos.add('/b', 'm2')
    const all = repos.list()
    expect(all).toContain('/a')
    expect(all).toContain('/b')
  })

  it('remove(path, machineId) removes the right machine repo', async () => {
    const { repos } = regWithTwoDaemons()
    await repos.add('/a', 'm1')
    await repos.add('/a', 'm2') // same path, different machine
    await repos.remove('/a', 'm1')
    expect(repos.list('m1')).not.toContain('/a')
    expect(repos.list('m2')).toContain('/a')
  })
})

describe('RepoRegistry.scanReposAll()', () => {
  it('stamps each repo with its originating machineId', async () => {
    const { reg, repos, m1Out, m2Out } = regWithTwoDaemons()
    await repos.add('/a', 'm1')
    await repos.add('/b', 'm2')

    // Fire the scan
    const scanPromise = repos.scanReposAll()

    // Each daemon receives a scanReposRequest; simulate their replies
    const m1Req = m1Out.find((m) => m.type === 'scanReposRequest')
    const m2Req = m2Out.find((m) => m.type === 'scanReposRequest')
    expect(m1Req).toBeDefined()
    expect(m2Req).toBeDefined()

    // Daemons reply with their repos (no machineId — server stamps it)
    reg.onDaemonMessageFrom('m1', {
      type: 'scanReposResult',
      requestId: (m1Req as Extract<ControlMessage, { type: 'scanReposRequest' }>).requestId,
      repositories: [{ path: '/a', kind: 'repository', worktrees: [] }],
      diagnostics: [],
    } as DaemonMessage)

    reg.onDaemonMessageFrom('m2', {
      type: 'scanReposResult',
      requestId: (m2Req as Extract<ControlMessage, { type: 'scanReposRequest' }>).requestId,
      repositories: [{ path: '/b', kind: 'repository', worktrees: [] }],
      diagnostics: [],
    } as DaemonMessage)

    const result = await scanPromise
    const byPath = Object.fromEntries(result.repositories.map((r) => [r.path, r]))

    expect(byPath['/a']).toBeDefined()
    expect(byPath['/a']?.machineId).toBe('m1')
    expect(byPath['/b']).toBeDefined()
    expect(byPath['/b']?.machineId).toBe('m2')
    expect(result.repositories).toHaveLength(2)
  })

  it('keeps a registered machine repo visible when that machine scan times out', async () => {
    const { reg, repos, store, m1Out, m2Out } = regWithTwoDaemons()
    store.repos.addRepo('/a', 'm1', 'https://github.com/acme/a.git')
    store.repos.addRepo('/b', 'm2', 'https://github.com/acme/b.git')

    const scanPromise = repos.scanReposAll()
    const m1Req = m1Out.find((m) => m.type === 'scanReposRequest')
    const m2Req = m2Out.find((m) => m.type === 'scanReposRequest')
    expect(m1Req).toBeDefined()
    expect(m2Req).toBeDefined()

    reg.onDaemonMessageFrom('m1', {
      type: 'scanReposResult',
      requestId: (m1Req as Extract<ControlMessage, { type: 'scanReposRequest' }>).requestId,
      repositories: [{ path: '/a', kind: 'repository', branch: 'main', worktrees: [] }],
      diagnostics: [],
    } as DaemonMessage)
    reg.onDaemonMessageFrom('m2', {
      type: 'scanReposResult',
      requestId: (m2Req as Extract<ControlMessage, { type: 'scanReposRequest' }>).requestId,
      repositories: [],
      diagnostics: [{ severity: 'error', path: '', message: 'repos scan timed out' }],
    } as DaemonMessage)

    const result = await scanPromise
    const byMachine = new Map(result.repositories.map((r) => [r.machineId, r]))
    const stored = store.repos.listRepos('m2')[0]

    expect(byMachine.get('m2')).toMatchObject({
      path: '/b',
      kind: 'repository',
      machineId: 'm2',
      originUrl: 'https://github.com/acme/b.git',
      repoId: stored?.repoId,
      worktrees: [],
    })
  })

  it('single-machine invariant: with one daemon scanReposAll equals scanRepos for that machine', async () => {
    // Single machine setup
    const store = new SessionStore(':memory:')
    store.machines.upsertMachine({ id: 'm1', name: 'one', hostname: 'one', tokenHash: 'x' })
    const reg = new SessionRegistry(store)
    const repos = new RepoRegistry(reg, store)
    const m1Out: ControlMessage[] = []
    reg.attachDaemon('m1', (msg) => m1Out.push(msg))
    await repos.add('/repo', 'm1')

    const scanPromise = repos.scanReposAll()

    const req = m1Out.find((m) => m.type === 'scanReposRequest')
    expect(req).toBeDefined()
    reg.onDaemonMessageFrom('m1', {
      type: 'scanReposResult',
      requestId: (req as Extract<ControlMessage, { type: 'scanReposRequest' }>).requestId,
      repositories: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
      diagnostics: [],
    } as DaemonMessage)

    const result = await scanPromise
    expect(result.repositories).toHaveLength(1)
    expect(result.repositories[0]?.path).toBe('/repo')
    expect(result.repositories[0]?.machineId).toBe('m1')
  })
})
