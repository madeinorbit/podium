import type { GitRepositoryWire, MachineWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { lastUsedMachine, machinesForRepo, reposToViews, resolveTargetMachine } from '../src/derive'

// --- helpers ---

const makeRepo = (
  path: string,
  opts: {
    originUrl?: string
    machineId?: string
    branch?: string
    worktrees?: { path: string; branch?: string }[]
  } = {},
): GitRepositoryWire => ({
  path,
  kind: 'repository',
  branch: opts.branch ?? 'main',
  originUrl: opts.originUrl,
  machineId: opts.machineId,
  worktrees: opts.worktrees ?? [],
})

const makeMachine = (id: string, online: boolean): MachineWire => ({
  id,
  name: id,
  hostname: `${id}.local`,
  online,
  lastSeenAt: '2026-06-17T00:00:00.000Z',
})

const makeSession = (machineId: string | undefined, createdAt: string): SessionMeta => ({
  sessionId: `sess-${createdAt}-${machineId ?? 'none'}`,
  agentKind: 'claude-code',
  title: 't',
  cwd: '/src/app',
  status: 'live',
  controllerId: null,
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  createdAt,
  lastActiveAt: createdAt,
  origin: { kind: 'spawn' },
  archived: false,
  machineId,
})

// --- reposToViews: multi-machine merging ---

describe('reposToViews (multi-machine)', () => {
  it('collapses two repos with the same origin onto different machines into one RepoView', () => {
    const repos: GitRepositoryWire[] = [
      makeRepo('/home/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
      makeRepo('/home/m2/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm2' }),
    ]
    const views = reposToViews(repos)
    expect(views).toHaveLength(1)
    expect(views[0].machines).toHaveLength(2)
    expect(views[0].machines.map((m) => m.machineId).sort()).toEqual(['m1', 'm2'])
  })

  it('keeps repos with different origins separate', () => {
    const repos: GitRepositoryWire[] = [
      makeRepo('/home/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
      makeRepo('/home/m1/other', { originUrl: 'git@github.com:acme/other.git', machineId: 'm1' }),
    ]
    const views = reposToViews(repos)
    expect(views).toHaveLength(2)
  })

  it('unions worktrees from both machines when collapsed', () => {
    const repos: GitRepositoryWire[] = [
      makeRepo('/m1/app', {
        originUrl: 'https://github.com/acme/app',
        machineId: 'm1',
        worktrees: [{ path: '/m1/app-feat', branch: 'feat' }],
      }),
      makeRepo('/m2/app', {
        originUrl: 'https://github.com/acme/app',
        machineId: 'm2',
        worktrees: [{ path: '/m2/app-main2', branch: 'main2' }],
      }),
    ]
    const [view] = reposToViews(repos)
    expect(view.worktrees).toHaveLength(4) // m1 main + m1 feat + m2 main + m2 main2
    const m1Worktrees = view.worktrees.filter((w) => w.machineId === 'm1')
    const m2Worktrees = view.worktrees.filter((w) => w.machineId === 'm2')
    expect(m1Worktrees).toHaveLength(2)
    expect(m2Worktrees).toHaveLength(2)
  })

  it('assigns machineId to each worktree in the merged view', () => {
    const repos: GitRepositoryWire[] = [
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
      makeRepo('/m2/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm2' }),
    ]
    const [view] = reposToViews(repos)
    for (const wt of view.worktrees) {
      expect(wt.machineId).toBeDefined()
    }
  })

  it('keeps remote-less repos separate per (machineId, path) even if paths match', () => {
    // Two repos with no remote — shouldn't merge even if path happens to be the same string
    const repos: GitRepositoryWire[] = [
      makeRepo('/local/repo', { machineId: 'm1' }),
      makeRepo('/local/repo', { machineId: 'm2' }),
    ]
    const views = reposToViews(repos)
    expect(views).toHaveLength(2)
  })

  it('keeps remote-less repos separate per path on the same machine', () => {
    const repos: GitRepositoryWire[] = [
      makeRepo('/local/repo-a', { machineId: 'm1' }),
      makeRepo('/local/repo-b', { machineId: 'm1' }),
    ]
    expect(reposToViews(repos)).toHaveLength(2)
  })

  it('sets originUrl on the RepoView when repos have a remote', () => {
    const repos: GitRepositoryWire[] = [
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
    ]
    const [view] = reposToViews(repos)
    expect(view.originUrl).toBe('github.com/acme/app')
  })
})

// --- reposToViews: single-machine invariant ---

describe('reposToViews (single-machine invariant)', () => {
  it('produces the same structural shape as before for a single-machine repo', () => {
    const repos: GitRepositoryWire[] = [
      makeRepo('/src/app', {
        originUrl: 'git@github.com:acme/app.git',
        machineId: 'm1',
        worktrees: [{ path: '/src/app-feat', branch: 'feat' }],
      }),
    ]
    const [view] = reposToViews(repos)
    // Same core fields
    expect(view.path).toBe('/src/app')
    expect(view.name).toBe('app')
    expect(view.worktrees).toHaveLength(2)
    expect(view.worktrees[0]).toMatchObject({
      path: '/src/app',
      isMain: true,
      repoPath: '/src/app',
    })
    expect(view.worktrees[1]).toMatchObject({
      path: '/src/app-feat',
      isMain: false,
      repoPath: '/src/app',
    })
    // New fields
    expect(view.machines).toEqual([{ machineId: 'm1', path: '/src/app' }])
  })

  it('still dedupes linked worktrees that appear as standalone entries', () => {
    const parent: GitRepositoryWire = {
      path: '/src/app',
      kind: 'repository',
      branch: 'main',
      worktrees: [{ path: '/src/app-feat', branch: 'feat' }],
    }
    const standalone: GitRepositoryWire = {
      path: '/src/app-feat',
      kind: 'worktree',
      branch: 'feat',
      worktrees: [],
    }
    const views = reposToViews([parent, standalone])
    expect(views).toHaveLength(1)
    expect(views[0].worktrees.map((w) => w.path)).toEqual(['/src/app', '/src/app-feat'])
  })

  it('produces machines: [] when repos have no machineId (legacy single-machine without stamp)', () => {
    const repos: GitRepositoryWire[] = [
      makeRepo('/src/app', { originUrl: 'git@github.com:acme/app.git' /* no machineId */ }),
    ]
    const [view] = reposToViews(repos)
    // No machineId on the wire → machines stays empty, worktrees have no machineId
    expect(view.machines).toEqual([])
    expect(view.worktrees[0].machineId).toBeUndefined()
  })
})

// --- machinesForRepo ---

describe('machinesForRepo', () => {
  it('returns only online machines that have the repo', () => {
    const repo = reposToViews([
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
      makeRepo('/m2/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm2' }),
    ])[0]
    const machines: MachineWire[] = [
      makeMachine('m1', true),
      makeMachine('m2', false), // offline
      makeMachine('m3', true), // online but doesn't have the repo
    ]
    const result = machinesForRepo(repo, machines)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('m1')
  })

  it('returns empty when no machine is online', () => {
    const repo = reposToViews([
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
    ])[0]
    const machines: MachineWire[] = [makeMachine('m1', false)]
    expect(machinesForRepo(repo, machines)).toHaveLength(0)
  })

  it('returns empty when no machine has the repo', () => {
    const repo = reposToViews([
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
    ])[0]
    const machines: MachineWire[] = [makeMachine('m2', true)]
    expect(machinesForRepo(repo, machines)).toHaveLength(0)
  })
})

// --- lastUsedMachine ---

describe('lastUsedMachine', () => {
  it('returns the machineId of the most recently created session', () => {
    const machines: MachineWire[] = [makeMachine('m1', true), makeMachine('m2', true)]
    const sessions = [
      makeSession('m1', '2026-06-17T10:00:00.000Z'),
      makeSession('m2', '2026-06-17T12:00:00.000Z'), // newest
      makeSession('m1', '2026-06-17T09:00:00.000Z'),
    ]
    expect(lastUsedMachine(sessions, machines)).toBe('m2')
  })

  it('ignores sessions on machines not in the given list', () => {
    const machines: MachineWire[] = [makeMachine('m1', true)]
    const sessions = [
      makeSession('m2', '2026-06-17T12:00:00.000Z'), // m2 not in list
      makeSession('m1', '2026-06-17T10:00:00.000Z'),
    ]
    expect(lastUsedMachine(sessions, machines)).toBe('m1')
  })

  it('returns undefined when no sessions belong to the given machines', () => {
    const machines: MachineWire[] = [makeMachine('m1', true)]
    const sessions = [makeSession('m2', '2026-06-17T12:00:00.000Z')]
    expect(lastUsedMachine(sessions, machines)).toBeUndefined()
  })

  it('returns undefined when sessions list is empty', () => {
    const machines: MachineWire[] = [makeMachine('m1', true)]
    expect(lastUsedMachine([], machines)).toBeUndefined()
  })

  it('ignores sessions with no machineId', () => {
    const machines: MachineWire[] = [makeMachine('m1', true)]
    const sessions = [makeSession(undefined, '2026-06-17T12:00:00.000Z')]
    expect(lastUsedMachine(sessions, machines)).toBeUndefined()
  })
})

// --- resolveTargetMachine ---

describe('resolveTargetMachine', () => {
  it('prefers the MRU machine that has the repo', () => {
    const repo = reposToViews([
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
      makeRepo('/m2/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm2' }),
    ])[0]
    const machines: MachineWire[] = [makeMachine('m1', true), makeMachine('m2', true)]
    const sessions = [
      makeSession('m1', '2026-06-17T10:00:00.000Z'),
      makeSession('m2', '2026-06-17T12:00:00.000Z'), // most recent
    ]
    expect(resolveTargetMachine(repo, sessions, machines)).toBe('m2')
  })

  it('falls back to the first eligible machine when no sessions exist', () => {
    const repo = reposToViews([
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
      makeRepo('/m2/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm2' }),
    ])[0]
    const machines: MachineWire[] = [makeMachine('m1', true), makeMachine('m2', true)]
    const result = resolveTargetMachine(repo, [], machines)
    // Should be the first machine from machinesForRepo (m1 or m2 — either is fine as long as it's one of them)
    expect(['m1', 'm2']).toContain(result)
  })

  it('ignores MRU machine if it is offline (not in machinesForRepo)', () => {
    const repo = reposToViews([
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
      makeRepo('/m2/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm2' }),
    ])[0]
    const machines: MachineWire[] = [
      makeMachine('m1', true),
      makeMachine('m2', false), // offline
    ]
    const sessions = [
      makeSession('m2', '2026-06-17T12:00:00.000Z'), // most recent but m2 is offline
      makeSession('m1', '2026-06-17T10:00:00.000Z'),
    ]
    // m2 is offline → not in machinesForRepo → lastUsedMachine on eligible=[m1] returns m1
    expect(resolveTargetMachine(repo, sessions, machines)).toBe('m1')
  })

  it('returns undefined when no machine has the repo online', () => {
    const repo = reposToViews([
      makeRepo('/m1/app', { originUrl: 'git@github.com:acme/app.git', machineId: 'm1' }),
    ])[0]
    const machines: MachineWire[] = [makeMachine('m1', false)]
    expect(resolveTargetMachine(repo, [], machines)).toBeUndefined()
  })
})
