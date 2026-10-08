import { reposToViews } from '@podium/client-core/values'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { asRepoId } from '@podium/model/browser'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { headerEntities } from './header-entities'
import { createLaunchCatalogPicker, createLaunchWorkPicker, launchOptionViews } from './launch-option-views'
import { MobxPool } from './pool'

it('keeps open phone repository deltas addressed at 1x/4x and releases demand on close', async () => {
  const samples = []
  for (const scale of [1, 4]) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const entities = headerEntities(pool)
    const repos: GitRepositoryWire[] = Array.from({ length: 128 * scale }, (_, at) => ({
      kind: 'repository',
      path: `/repo/${at}`,
      originUrl: `https://example.test/p${at}`,
      worktrees: Array.from({ length: 8 }, (_, tree) => ({
        path: `/repo/${at}/tree-${tree}`,
        branch: 'topic',
      })),
    }))
    entities.apply([
      ...repos.map((value, at) => ({ kind: 'repository' as const, id: `r${at}`, value })),
      { kind: 'machine', id: 'm0', value: { id: 'm0', name: 'Host', online: true } as MachineWire },
    ])
    const activity = observable.map<string, number>()
    const query = vi
      .spyOn(pool.queries, 'activity')
      .mockImplementation((question) => activity.get(question.roots[0]!) ?? 0)
    const latest = vi.spyOn(pool.queries, 'latestMachineSession').mockReturnValue(undefined)
    const views = launchOptionViews(pool), picker = createLaunchWorkPicker(pool)
    picker.open()
    let work!: ReturnType<typeof picker.newWork>
    let paths!: string[]
    const stop = autorun(() => {
      work = picker.newWork()
      paths = picker.repositoryPaths
    })
    try {
      expect(work.repos).toEqual(
        reposToViews(repos)
          .map((repo) => ({
            ...repo,
            worktrees: repo.worktrees.map((tree) => ({
              ...tree,
              repoName: repo.name,
              sessions: [],
              issues: [],
            })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      )
      expect(paths).toEqual(
        repos
          .map((repo) => repo.path)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
      )
      const before = { ...views.counts },
        hosts = work.machines,
        other = work.repos.find((repo) => repo.path === '/repo/17')
      const changed = await measureWork(
        async () =>
          entities.apply([
            { kind: 'repository', id: 'r0', value: { ...repos[0]!, branch: 'changed' } },
          ]),
        { pool },
      )
      expect(views.counts.repositoryBuilds - before.repositoryBuilds).toBe(1)
      expect(views.counts.usageQueries).toBe(before.usageQueries)
      expect(work.machines).toBe(hosts)
      expect(work.repos.find((repo) => repo.path === '/repo/17')).toBe(other)
      expect(work.repos.find((repo) => repo.path === '/repo/0')?.worktrees[0]?.branch).toBe(
        'changed',
      )
      const beforeUsage = { ...views.counts }
      query.mockClear()
      const used = await measureWork(async () => runInAction(() => activity.set('/repo/23', 100)), {
        pool,
      })
      expect(paths[0]).not.toBe('/repo/23')
      expect(work.repos[0]?.path).not.toBe('/repo/23')
      expect(query).not.toHaveBeenCalled()
      expect(views.counts.repositoryBuilds).toBe(beforeUsage.repositoryBuilds)
      expect(views.counts.usageQueries).toBe(beforeUsage.usageQueries)
      picker.open()
      expect(paths[0]).toBe('/repo/23')
      expect(work.repos[0]?.path).toBe('/repo/23')
      expect(picker.repositoryActivity('/repo/23')).toBe(100)
      stop()
      const closedCounts = { ...views.counts }
      const closed = await measureWork(
        async () =>
          entities.apply([
            { kind: 'repository', id: 'r0', value: { ...repos[0]!, branch: 'closed' } },
          ]),
        { pool },
      )
      expect(views.counts).toEqual(closedCounts)
      expect(closed.work.rows).toBe(0)
      samples.push({
        scale,
        changed: changed.work.rows,
        used: used.work.rows,
        closed: closed.work.rows,
      })
    } finally {
      stop()
      query.mockRestore()
      latest.mockRestore()
      pool.dispose()
    }
  }
  console.info('[open phone launcher rows 1x4x]', JSON.stringify(samples))
  expect(samples[1]).toEqual({ ...samples[0], scale: 4 })
})

it('preserves clone ordering, linked-scan exclusion, and pinned project choices', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const entities = headerEntities(pool)
  const clone = (path: string): GitRepositoryWire => ({
    kind: 'repository',
    path,
    repoId: asRepoId('same'),
    worktrees: [{ path: `${path}/linked` }],
  })
  const repos = [
    clone('/first'),
    clone('/second'),
    { kind: 'worktree' as const, path: '/first/linked', worktrees: [] },
    { kind: 'worktree' as const, path: '/unlisted', worktrees: [] },
  ]
  entities.apply(repos.map((value, at) => ({ kind: 'repository' as const, id: `r${at}`, value })))
  const activity = vi.spyOn(pool.queries, 'activity').mockReturnValue(0)
  const latest = vi.spyOn(pool.queries, 'latestMachineSession').mockReturnValue(undefined)
  const pins = observable.box({
    repos: ['/first'],
    worktrees: ['/first', '/first/linked', '/second', '/second/linked', '/unlisted'],
  })
  pool.sources.register(['commandWindow'], {
    read: () =>
      ({
        get pins() {
          return pins.get()
        },
      }) as never,
    dispose() {},
  })
  const views = launchOptionViews(pool), picker = createLaunchWorkPicker(pool), catalog = createLaunchCatalogPicker(pool)
  picker.open(); catalog.open()
  let projects!: ReturnType<typeof picker.newWork>
  const stop = autorun(() => {
    projects = picker.newWork()
  })
  try {
    expect(views.origin('/first').repo).toEqual(reposToViews(repos)[0])
    expect(catalog.catalog().repoPaths).toEqual(['/first', '/second'])
    expect(catalog.catalog().initialRepoPath).toBe('/first')
    expect(projects.repos).toMatchObject([{ path: '/first', worktrees: [] }])
    runInAction(() => pins.set({ repos: [], worktrees: pins.get().worktrees }))
    expect(projects.repos).toEqual([])
    runInAction(() => entities.order('repository', ['r1', 'r0', 'r2']))
    expect(picker.repositoryPaths).toEqual(['/second'])
    expect(catalog.catalog().repoPaths).toEqual(['/first', '/second'])
    expect(catalog.catalog().initialRepoPath).toBe('/first')
    catalog.open()
    expect(catalog.catalog().initialRepoPath).toBe('/second')
    entities.apply([{ kind: 'repository', id: 'r1', value: undefined }])
    expect(picker.repositoryPaths).toEqual(['/first'])
    expect(catalog.catalog().repoPaths).toEqual(['/first'])
    entities.order('repository', ['r3'])
    expect(catalog.catalog().repoPaths).toEqual([])
    catalog.open()
    expect(catalog.catalog().initialRepoPath).toBe('/unlisted')
  } finally {
    stop()
    activity.mockRestore()
    latest.mockRestore()
    pool.dispose()
  }
})

it('keeps exact new-work usage distinct from containing-path new-task usage', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  headerEntities(pool).apply(
    ['/a', '/b'].map((path) => ({
      kind: 'repository' as const,
      id: path,
      value: { kind: 'repository' as const, path, worktrees: [] },
    })),
  )
  const query = vi
    .spyOn(pool.queries, 'activity')
    .mockImplementation((question) =>
      question.roots[0] === (question.match === 'exact' ? '/a' : '/b') ? 100 : 0,
    )
  const latest = vi.spyOn(pool.queries, 'latestMachineSession').mockReturnValue(undefined)
  const picker = createLaunchWorkPicker(pool)
  picker.open()
  const stop = autorun(() => {
    picker.newWork()
    picker.repositoryPaths
  })
  try {
    expect(picker.newWork().repos[0]?.path).toBe('/a')
    expect(picker.repositoryPaths[0]).toBe('/b')
  } finally {
    stop()
    query.mockRestore()
    latest.mockRestore()
    pool.dispose()
  }
})
