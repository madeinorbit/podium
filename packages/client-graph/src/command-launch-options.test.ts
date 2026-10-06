import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { reposToViews } from '@podium/client-core/values'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { attachCommandLaunchSource } from './command-launch-source'
import { commandLaunchViews } from './command-launch-views'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

/** The source's actual list/local boundary, without booting unrelated history.
 * The production source still owns all rows, ordering and relation updates. */
function fixture(scale: number) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const repos: GitRepositoryWire[] = Array.from({ length: 128 * scale }, (_, at) => ({
    kind: 'repository',
    path: `/repo/${at}`,
    originUrl: `https://example.test/p${at}`,
    worktrees: Array.from({ length: 8 }, (_, tree) => ({
      path: `/repo/${at}/tree-${tree}`,
      branch: 'topic',
    })),
  }))
  const lists = new Map<string, Map<string, object>>([
    ['repos', new Map(repos.map((repo, at) => [`r${at}`, repo]))],
    ['machines', new Map([['m0', { id: 'm0', name: 'Host', online: true } as MachineWire]])],
  ])
  const window: Record<string, unknown> = {
    pins: { repos: [], worktrees: [] },
    selectedWorktree: null,
    selectedIssueId: null,
    openIssueId: null,
    paletteOpen: false,
    paneA: null,
    recentFiles: [],
    sidebarSettings: {},
  }
  const listeners = new Map<string, () => void>()
  const runtime = {
    listIds: (key: string) => [...lists.get(key)!.keys()],
    listRow: (key: string, id: string) => lists.get(key)!.get(id),
    readLocal: (key: string) => window[key],
    onLocals: () => () => {},
    onList: (key: string, callback: () => void) => {
      listeners.set(key, callback)
      return () => {
        listeners.delete(key)
      }
    },
  } as unknown as ClientRuntime<PodiumClientApi>
  const ids = vi.spyOn(pool.queries, 'ids').mockReturnValue([])
  const activity = observable.map<string, number>()
  const query = vi
    .spyOn(pool.queries, 'activity')
    .mockImplementation((question) => activity.get(question.roots[0]!) ?? 0)
  attachCommandLaunchSource(pool, runtime)
  return {
    pool,
    repos,
    activity,
    discover(next: GitRepositoryWire[]) {
      lists.set('repos', new Map(next.map((repo, at) => [`r${at}`, repo])))
      listeners.get('repos')!()
    },
    close() {
      ids.mockRestore()
      query.mockRestore()
      pool.dispose()
    },
  }
}

it('keeps supported web repository and usage deltas addressed at 1x/4x, with output parity and zero closed demand', async () => {
  const samples = []
  for (const scale of [1, 4]) {
    const f = fixture(scale),
      views = commandLaunchViews(f.pool)
    let data!: ReturnType<typeof views.launch>
    const stop = autorun(() => {
      data = views.launch()
    })
    const value = () => {
      if (!data || data === LOADING) throw new Error('Launch options did not settle')
      return data
    }
    try {
      const initial = value(),
        before = { ...views.counts }
      expect(initial.repoViews).toEqual(reposToViews(f.repos))
      const used = await measureWork(
        async () => runInAction(() => f.activity.set('/repo/23', 100)),
        { pool: f.pool },
      )
      expect(value().initialRepoPath).toBe('/repo/23')
      expect(value().repoChoices[0]?.path).toBe('/repo/23')
      expect(value().spawnTargets[0]?.path).toBe('/repo/23')
      expect(value().repoViews).toBe(initial.repoViews)
      expect(value().machines).toBe(initial.machines)
      expect(views.counts.repositoryBuilds).toBe(before.repositoryBuilds)
      expect(views.counts.optionUsageQueries - before.optionUsageQueries).toBe(1)
      const beforeDiscovery = { ...views.counts }
      const oldRepos = new Map(value().repoViews.map((repo) => [repo.path, repo]))
      const changed = await measureWork(
        async () =>
          f.discover(f.repos.map((repo, at) => (at === 0 ? { ...repo, branch: 'renamed' } : repo))),
        { pool: f.pool },
      )
      expect(views.counts.repositoryBuilds - beforeDiscovery.repositoryBuilds).toBe(1)
      expect(views.counts.optionUsageQueries).toBe(beforeDiscovery.optionUsageQueries)
      expect(value().machines).toBe(initial.machines)
      for (const repo of value().repoViews)
        if (repo.path !== '/repo/0') expect(repo).toBe(oldRepos.get(repo.path))
      const palette = runInAction(() => views.palette())
      if (!palette || palette === LOADING) throw new Error('Palette reference did not settle')
      for (const key of [
        'repoViews',
        'repoChoices',
        'initialRepoPath',
        'usage',
        'spawnTargets',
      ] as const)
        expect(value()[key], key).toEqual(palette[key])
      stop()
      const beforeClose = { ...views.counts }
      const closed = await measureWork(
        async () => runInAction(() => f.activity.set('/repo/17', 200)),
        { pool: f.pool },
      )
      expect(views.counts).toEqual(beforeClose)
      expect(closed.work.rows).toBe(0)
      samples.push({
        scale,
        changedRows: changed.work.rows,
        usageRows: used.work.rows,
        closedRows: closed.work.rows,
      })
    } finally {
      stop()
      f.close()
    }
  }
  console.info('[open web launcher rows 1x4x]', JSON.stringify(samples))
  expect(samples[1]).toEqual({ ...samples[0], scale: 4 })
})

it('keeps discovery ordering when clones are interleaved and the first clone is removed', () => {
  const f = fixture(1),
    views = commandLaunchViews(f.pool)
  const clone = { ...f.repos[0]!, path: '/clone', worktrees: [{ path: '/clone/topic' }] }
  const stop = autorun(() => views.launch())
  try {
    f.discover([f.repos[0]!, f.repos[1]!, clone])
    const data = views.launch()
    if (!data || data === LOADING) throw new Error('Launch options did not settle')
    expect(data.repoViews).toEqual(reposToViews([f.repos[0]!, f.repos[1]!, clone]))
    f.discover([clone, f.repos[1]!])
    const next = views.launch()
    if (!next || next === LOADING) throw new Error('Launch options did not settle')
    expect(next.repoViews).toEqual(reposToViews([clone, f.repos[1]!]))
  } finally {
    stop()
    f.close()
  }
})
