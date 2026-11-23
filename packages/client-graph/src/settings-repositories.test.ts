import { seedFixtureMachines } from '@podium/client-graph/live-fixture'
import type { GitRepositoryWire } from '@podium/model'
import { asMachineId, asRepoId } from '@podium/model/browser'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { headerEntities } from './header-entities'
import { MobxPool } from './pool'
import { SettingsRepositories } from './settings-repositories'

/**
 * POD-6267: Settings → Projects lists REPOSITORY RECORDS, and takes their
 * checkouts from what the machines publish. Every fixture below is built the way
 * the producer builds it (see `published`), because the first two landings were
 * tested on fixtures the producer never sends.
 */
const ludovico = asMachineId('m-ludovico')
const flatblock = asMachineId('m-flatblock')
const podium = asRepoId('repo-podium')
const site = asRepoId('repo-site')
const ORIGIN = 'git@github.com:acme/podium.git'

type Repo = {
  id: string
  name?: string
  prefix?: string | null
  defaultParentBranch?: string | null
}

/**
 * What `scanReposAll` publishes for one root on one machine. The scanner's
 * `withRegisteredWorktrees` reports the root with its worktree list AND one
 * `kind: 'worktree'` scan per linked worktree (`toWorktreeRepository`: path,
 * branch, the root's origin). The server then stamps the repo id on REGISTERED
 * paths only: the root when it is registered, and a worktree only when that
 * worktree path was registered too.
 */
function published(
  machineId: GitRepositoryWire['machineId'],
  root: string,
  options: {
    repoId?: GitRepositoryWire['repoId']
    originUrl?: string
    trees?: string[]
    registeredTrees?: string[]
    kind?: GitRepositoryWire['kind']
  },
): GitRepositoryWire[] {
  const { repoId, originUrl, trees = [], registeredTrees = [], kind = 'repository' } = options
  const worktrees = trees.map((tree) => ({ path: `${root}-${tree}`, branch: `issue/${tree}` }))
  return [
    {
      kind,
      machineId,
      path: root,
      ...(kind === 'bare' ? {} : { branch: 'main' }),
      ...(originUrl ? { originUrl } : {}),
      ...(repoId ? { repoId } : {}),
      worktrees,
    },
    ...worktrees.map(
      (tree, i): GitRepositoryWire => ({
        kind: 'worktree',
        machineId,
        path: tree.path,
        branch: tree.branch,
        ...(originUrl ? { originUrl } : {}),
        ...(repoId && registeredTrees.includes(trees[i] as string) ? { repoId } : {}),
        worktrees: [],
      }),
    ),
  ]
}

function scene(repos: Repo[], scans: GitRepositoryWire[]) {
  const p = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  p.apply({
    type: 'update',
    rows: repos.map((repo) => ({
      kind: 'repo' as const,
      id: repo.id,
      value: { prefix: null, defaultParentBranch: null, path: '/', ...repo } as never,
    })),
  })
  headerEntities(p).apply([
    ...seedFixtureMachines(p, [
      { id: ludovico, name: 'ludovico', online: true },
      { id: flatblock, name: 'flatblock', online: false },
    ] as never),
    ...scans.map((value, i) => ({ kind: 'repository' as const, id: `scan${i}`, value })),
  ])
  headerEntities(p).order(
    'repository',
    scans.map((_, i) => `scan${i}`),
  )
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

it('shows a registered root and the scanner’s scans of its worktrees as one repository', () => {
  const { p, section } = scene(
    [{ id: podium, name: 'podium', prefix: 'POD', defaultParentBranch: 'dev' }],
    published(ludovico, '/src/podium', {
      repoId: podium,
      originUrl: ORIGIN,
      trees: ['340', '389', '7'],
    }),
  )
  try {
    expect(shape(section)).toEqual([
      {
        name: 'podium',
        prefix: 'POD',
        checkouts: ['ludovico:/src/podium[/src/podium-340,/src/podium-389,/src/podium-7]'],
      },
    ])
    const [row] = section.rows
    expect(row?.origin).toBe('github.com/acme/podium')
    expect(row?.defaultParentBranch).toBe('dev')
    expect(row?.worktreeCount).toBe(3)
    expect(row?.checkouts[0]?.branch).toBe('main')
    expect(row?.checkouts[0]?.machineOnline).toBe(true)
  } finally {
    p.dispose()
  }
})

it('lists one checkout per machine, by machine name, and writes through an online one', () => {
  const { p, section } = scene(
    [{ id: podium, name: 'podium', prefix: 'POD' }],
    [
      ...published(ludovico, '/src/podium', { repoId: podium, originUrl: ORIGIN }),
      ...published(flatblock, '/home/u/podium', {
        repoId: podium,
        originUrl: ORIGIN,
        trees: ['1'],
      }),
    ],
  )
  try {
    expect(shape(section)).toEqual([
      {
        name: 'podium',
        prefix: 'POD',
        checkouts: ['flatblock:/home/u/podium[/home/u/podium-1]', 'ludovico:/src/podium[]'],
      },
    ])
    expect(section.rows[0]?.writeCheckout?.path).toBe('/src/podium')
  } finally {
    p.dispose()
  }
})

it('keeps a registered worktree inside the root that lists it, and alone where its root is not registered', () => {
  const { p, section } = scene(
    [{ id: podium, name: 'podium', prefix: 'POD' }],
    [
      // ludovico: root and one of its worktrees are both registered.
      ...published(ludovico, '/src/podium', {
        repoId: podium,
        originUrl: ORIGIN,
        trees: ['12'],
        registeredTrees: ['12'],
      }),
      // flatblock: only a worktree is registered; its root is not.
      ...published(flatblock, '/w/podium-5', {
        repoId: podium,
        originUrl: ORIGIN,
        kind: 'worktree',
      }),
    ],
  )
  try {
    expect(shape(section)).toEqual([
      {
        name: 'podium',
        prefix: 'POD',
        checkouts: ['flatblock:/w/podium-5[]', 'ludovico:/src/podium[/src/podium-12]'],
      },
    ])
    expect(section.rows[0]?.checkouts[0]?.linked).toBe(true)
  } finally {
    p.dispose()
  }
})

it('lists only repository records with a checkout, by name; unregistered folders are not repositories', () => {
  const { p, section } = scene(
    [
      { id: podium, name: 'podium', prefix: 'POD' },
      { id: site, name: 'Site' },
      // A repository no machine reports any more (its tasks still exist).
      { id: asRepoId('repo-gone'), name: 'gone', prefix: 'OLD' },
    ],
    [
      ...published(ludovico, '/src/site', { repoId: site }),
      ...published(ludovico, '/src/podium', { repoId: podium, originUrl: ORIGIN }),
      // A folder a scan reached that nobody registered: no repo id.
      ...published(ludovico, '/src/scratch', { trees: ['a'] }),
    ],
  )
  try {
    expect(shape(section)).toEqual([
      { name: 'podium', prefix: 'POD', checkouts: ['ludovico:/src/podium[]'] },
      { name: 'Site', prefix: null, checkouts: ['ludovico:/src/site[]'] },
    ])
    expect(section.rows[1]?.origin).toBeNull()
  } finally {
    p.dispose()
  }
})

it('names a row by the server-decided name, a checkout’s folder only until one arrives', () => {
  const { p, section } = scene(
    [{ id: podium }],
    published(ludovico, '/src/bak_podium', { repoId: podium }),
  )
  try {
    const row = section.rows[0]
    if (!row) throw new Error('no row')
    const seen: string[] = []
    const stop = autorun(() => seen.push(row.name))
    const named = (name: string) => ({
      kind: 'repo' as const,
      id: podium,
      value: {
        id: podium,
        name,
        prefix: 'POD',
        defaultParentBranch: null,
        path: '/src/podium',
      } as never,
    })
    p.apply({ type: 'update', rows: [named('podium')] })
    p.apply({ type: 'update', rows: [named('podium-core')] })
    expect(seen).toEqual(['bak_podium', 'podium', 'podium-core'])
    expect(row.prefix).toBe('POD')
    stop()
  } finally {
    p.dispose()
  }
})

it('keeps the row and follows a worktree git starts listing', () => {
  const root = published(ludovico, '/src/podium', { repoId: podium, originUrl: ORIGIN })
  const { p, section } = scene([{ id: podium, name: 'podium' }], root)
  try {
    const row = section.rows[0]
    expect(row?.worktreeCount).toBe(0)
    const [next] = published(ludovico, '/src/podium', {
      repoId: podium,
      originUrl: ORIGIN,
      trees: ['9'],
    })
    headerEntities(p).apply([{ kind: 'repository', id: 'scan0', value: next as GitRepositoryWire }])
    expect(section.rows[0]).toBe(row)
    expect(row?.worktreeCount).toBe(1)
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
