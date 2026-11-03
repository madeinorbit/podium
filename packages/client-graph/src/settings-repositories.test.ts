import type { GitRepositoryWire } from '@podium/model'
import { asMachineId, asRepoId } from '@podium/model/browser'
import { expect, it } from 'vitest'
import { headerEntities } from './header-entities'
import { MobxPool } from './pool'
import { SettingsRepositories } from './settings-repositories'

/**
 * POD-6267: Settings → Repositories lists REPOSITORIES. Every case below is a
 * shape the machines really report, and under the old one-row-per-scan list
 * each extra scan in it was a row of its own.
 */
const ludovico = asMachineId('m-ludovico')
const flatblock = asMachineId('m-flatblock')
const podium = asRepoId('repo-podium')
const site = asRepoId('repo-site')
const ORIGIN = 'git@github.com:acme/podium.git'

function scene(scans: GitRepositoryWire[]) {
  const p = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  p.apply({
    type: 'update',
    rows: [
      {
        kind: 'repo',
        id: podium,
        value: {
          id: podium,
          prefix: 'POD',
          defaultParentBranch: 'dev',
          path: '/src/podium',
        } as never,
      },
      {
        kind: 'repo',
        id: site,
        value: { id: site, prefix: null, defaultParentBranch: null, path: '/src/site' } as never,
      },
    ],
  })
  headerEntities(p).apply([
    {
      kind: 'machine',
      id: ludovico,
      value: { id: ludovico, name: 'ludovico', online: true } as never,
    },
    {
      kind: 'machine',
      id: flatblock,
      value: { id: flatblock, name: 'flatblock', online: false } as never,
    },
    ...scans.map((value, i) => ({ kind: 'repository' as const, id: `scan${i}`, value })),
  ])
  return { p, section: new SettingsRepositories(p) }
}

const shape = (section: SettingsRepositories) =>
  section.rows.map((row) => ({
    name: row.name,
    prefix: row.prefix,
    checkouts: row.checkouts.map(
      (c) => `${c.machineName}:${c.path}[${c.worktrees.map((w) => w.path).join(',')}]`,
    ),
  }))

it('folds registered worktrees into their checkout and lists the repository once', () => {
  const { p, section } = scene([
    {
      kind: 'repository',
      machineId: ludovico,
      repoId: podium,
      originUrl: ORIGIN,
      path: '/src/podium',
      branch: 'main',
      worktrees: [
        { path: '/src/podium-12', branch: 'pod-12' },
        { path: '/src/podium-7', branch: 'pod-7', prunable: true },
      ],
    },
    // Registered worktrees: one git lists, one it does not (a stale scan).
    {
      kind: 'worktree',
      machineId: ludovico,
      repoId: podium,
      originUrl: ORIGIN,
      path: '/src/podium-12',
      branch: 'pod-12',
      worktrees: [],
    },
    {
      kind: 'worktree',
      machineId: ludovico,
      repoId: podium,
      originUrl: ORIGIN,
      path: '/src/podium-30',
      branch: 'pod-30',
      worktrees: [],
    },
  ])
  try {
    expect(shape(section)).toEqual([
      {
        name: 'podium',
        prefix: 'POD',
        checkouts: ['ludovico:/src/podium[/src/podium-12,/src/podium-30,/src/podium-7]'],
      },
    ])
    const [row] = section.rows
    expect(row!.origin).toBe('github.com/acme/podium')
    expect(row!.defaultParentBranch).toBe('dev')
    expect(row!.worktreeCount).toBe(3)
    expect(row!.checkouts[0]!.missingWorktreeCount).toBe(1)
    expect(row!.checkouts[0]!.branch).toBe('main')
    expect(row!.checkouts[0]!.machineOnline).toBe(true)
  } finally {
    p.dispose()
  }
})

it('shows one repository with a checkout per machine, by machine name', () => {
  const { p, section } = scene([
    {
      kind: 'repository',
      machineId: ludovico,
      repoId: podium,
      originUrl: ORIGIN,
      path: '/src/podium',
      worktrees: [],
    },
    {
      kind: 'repository',
      machineId: flatblock,
      repoId: podium,
      originUrl: ORIGIN,
      path: '/home/u/podium',
      worktrees: [{ path: '/home/u/podium-1' }],
    },
  ])
  try {
    expect(shape(section)).toEqual([
      {
        name: 'podium',
        prefix: 'POD',
        checkouts: ['flatblock:/home/u/podium[/home/u/podium-1]', 'ludovico:/src/podium[]'],
      },
    ])
    expect(section.rows[0]!.checkouts[0]!.machineOnline).toBe(false)
  } finally {
    p.dispose()
  }
})

it('keeps a registered worktree whose root no machine registered, as a checkout of its own', () => {
  const { p, section } = scene([
    {
      kind: 'repository',
      machineId: ludovico,
      repoId: podium,
      originUrl: ORIGIN,
      path: '/src/podium',
      worktrees: [],
    },
    {
      kind: 'worktree',
      machineId: flatblock,
      repoId: podium,
      originUrl: ORIGIN,
      path: '/w/podium-5',
      branch: 'pod-5',
      worktrees: [{ path: '/w/podium-5' }],
    },
  ])
  try {
    expect(shape(section)).toEqual([
      {
        name: 'podium',
        prefix: 'POD',
        checkouts: ['flatblock:/w/podium-5[]', 'ludovico:/src/podium[]'],
      },
    ])
    expect(section.rows[0]!.checkouts[0]!.linked).toBe(true)
  } finally {
    p.dispose()
  }
})

it('lists separate repositories by name, and a scan with no repository id on its own', () => {
  const { p, section } = scene([
    { kind: 'repository', machineId: ludovico, repoId: site, path: '/src/site', worktrees: [] },
    {
      kind: 'repository',
      machineId: ludovico,
      repoId: podium,
      originUrl: ORIGIN,
      path: '/src/podium',
      worktrees: [],
    },
    { kind: 'repository', machineId: ludovico, path: '/src/scratch', worktrees: [] },
  ])
  try {
    expect(shape(section)).toEqual([
      { name: 'podium', prefix: 'POD', checkouts: ['ludovico:/src/podium[]'] },
      { name: 'scratch', prefix: null, checkouts: ['ludovico:/src/scratch[]'] },
      { name: 'site', prefix: null, checkouts: ['ludovico:/src/site[]'] },
    ])
    expect(section.rows.map((row) => row.repoId)).toEqual([podium, null, site])
    expect(section.rows[2]!.origin).toBeNull()
  } finally {
    p.dispose()
  }
})

it('keeps the row and follows a new worktree arriving on the checkout', () => {
  const root: GitRepositoryWire = {
    kind: 'repository',
    machineId: ludovico,
    repoId: podium,
    originUrl: ORIGIN,
    path: '/src/podium',
    worktrees: [],
  }
  const { p, section } = scene([root])
  try {
    const row = section.rows[0]!
    expect(row.worktreeCount).toBe(0)
    headerEntities(p).apply([
      {
        kind: 'repository',
        id: 'scan0',
        value: { ...root, worktrees: [{ path: '/src/podium-9', branch: 'pod-9' }] },
      },
    ])
    expect(section.rows[0]).toBe(row)
    expect(row.worktreeCount).toBe(1)
  } finally {
    p.dispose()
  }
})

it('reads an empty list as "not yet" until the machines report, then as "none"', () => {
  const p = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  try {
    const section = new SettingsRepositories(p)
    expect(section.loaded).toBe(false)
    headerEntities(p).order('repository', [])
    expect(section.loaded).toBe(true)
    expect(section.rows).toEqual([])
  } finally {
    p.dispose()
  }
})
