import { lazy, keyedComputed } from '@podium/mobx-helpers'
import {
  machineViewsFromWire,
  reposToViews,
  usableMachines,
  type RepoNavView,
} from '@podium/client-core/values'
import { type GitRepositoryWire, machinePathBasename, machinePathKey, machinePathsEqual } from '@podium/model/browser'
import { action, computed, observable, observableRef } from 'mobx'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import type { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

/** Open launchers own these computeds. Metadata belongs to one repository
 * group; usage ordering consumes cached scalars, never re-groups worktrees. */
export function launchOptionViews(pool: MobxPool) {
  return pool.sources.view('launch.options', () => {
    const counts = { repositoryBuilds: 0, usageQueries: 0 }
    const repository = keyedComputed('launch.repository', (id: string) => {
      counts.repositoryBuilds++
      const scans = headerEntities(pool)
        .repositoryGroupRoots(id)
        .flatMap((id) => {
          const row = pool.row('repository', id) as GitRepositoryWire | undefined
          return row && typeof row !== 'symbol' ? [row] : []
        })
      return reposToViews(scans)[0]
    })
    const machines = computed(() => headerView(pool).machines())
    const rootKey = keyedComputed(
      'launch.roots',
      (id: string) => {
        const repo = repository(id)
        return JSON.stringify(repo ? [repo.path, ...repo.worktrees.map((tree) => tree.path)] : [])
      },
    )
    const usage = keyedComputed('launch.usage', (key: string) => {
      const [id, match] = JSON.parse(key) as [string, 'exact' | 'within']
      counts.usageQueries++
      return pool.queries.activity({ kind: 'commandRootActivity', roots: JSON.parse(rootKey(id)) as string[], match })
    })
    const pathOrderKey = computed(
      () => JSON.stringify(
        headerEntities(pool)
          .repositoryGroupIds()
          .flatMap((id) => {
            const repo = repository(id)
            return repo ? [{ path: repo.path, at: usage(JSON.stringify([id, 'within'])) }] : []
          })
          .sort(
            (a, b) =>
              b.at - a.at || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }),
          )
          .map(({ path }) => path)),
    )
    const paths = computed(() => JSON.parse(pathOrderKey.get()) as string[])
    const pins = computed(() => {
      const row = pool.row('commandWindow', 'window')
      return row && row !== LOADING ? row.pins : EMPTY_PINS
    })
    const project = keyedComputed('launch.project', (id: string): RepoNavView | undefined => {
      const repo = repository(id)
      if (!repo) return undefined
      const pinned = pins.get().worktrees
      return {
        ...repo,
        worktrees: repo.worktrees.flatMap((tree) =>
          pinned.some(path => machinePathsEqual(path, tree.path))
            ? []
            : [{ ...tree, repoName: repo.name, sessions: [], issues: [] }],
        ),
      }
    })
    const projectOrderKey = computed(() => {
      const pinned = pins.get().repos
      const values = headerEntities(pool)
        .repositoryGroupIds()
        .flatMap((id) => {
          const repo = project(id)
          return repo && (pinned.some(path => machinePathsEqual(path, repo.path)) || repo.worktrees.length)
            ? [{ id, repo, at: usage(JSON.stringify([id, 'exact'])) }]
            : []
        })
      // Pinned order breaks otherwise equal choices, as in the existing menu.
      const pinOrder = new Map(pinned.map((path, at) => [machinePathKey(path), at]))
      values.sort(
        (a, b) =>
          b.at - a.at ||
          a.repo.name.localeCompare(b.repo.name, undefined, { sensitivity: 'base' }) ||
          (pinOrder.get(machinePathKey(a.repo.path)) ?? pinned.length) -
            (pinOrder.get(machinePathKey(b.repo.path)) ?? pinned.length),
      )
      return JSON.stringify(values.map(value => value.id))
    })
    const projects = computed(() => (JSON.parse(projectOrderKey.get()) as string[])
      .flatMap(id => project(id) ?? []))
    const catalogRoot = keyedComputed('launch.catalogRoot', (id: string) => {
      const row = pool.row('repository', id) as GitRepositoryWire | undefined
      return row && typeof row !== 'symbol' ? row : undefined
    })
    const catalogRoots = keyedComputed('launch.catalogRoots', (id: string) => {
      const repo = catalogRoot(id)
      return JSON.stringify(repo ? [repo.path, ...repo.worktrees.map(tree => tree.path)] : [])
    })
    const catalogUsage = keyedComputed('launch.catalogUsage', (id: string) =>
      pool.queries.activity({ kind: 'commandRootActivity', roots: JSON.parse(catalogRoots(id)) as string[] }))
    const catalogOrder = computed(() => {
      const values = headerEntities(pool).repositoryRootIds().flatMap(id => {
        const repo = catalogRoot(id)
        return repo && repo.kind !== 'worktree' ? [{ id, path: repo.path, at: catalogUsage(id) }] : []
      })
      // The default keeps discovery order on equal usage, while displayed
      // choices break ties by basename as the existing New Issue dialog does.
      let initial = values.reduce<(typeof values)[number] | undefined>((best, value) =>
        !best || value.at > best.at ? value : best, undefined)?.path
      if (initial === undefined) {
        const id = headerEntities(pool).firstId('repository')
        initial = id ? catalogRoot(id)?.path ?? '' : ''
      }
      values.sort((a, b) => b.at - a.at ||
        (machinePathBasename(a.path) || a.path).localeCompare(
          machinePathBasename(b.path) || b.path, undefined, { sensitivity: 'base' }))
      return JSON.stringify({ initial, ids: values.map(value => value.id) })
    })
    const catalogPaths = computed(() => {
      const { ids } = JSON.parse(catalogOrder.get()) as { ids: string[] }
      return ids.flatMap(id => catalogRoot(id)?.path ?? [])
    })
    const catalog = computed(() => ({
      initialRepoPath: (JSON.parse(catalogOrder.get()) as { initial: string }).initial,
      repoPaths: catalogPaths.get(),
      machines: machines.get(),
    }))
    const eligibleMachineKey = computed(
      () => JSON.stringify(usableMachines(machineViewsFromWire(machines.get())).map((machine) => machine.id)),
    )
    const recentMachineKey = computed(() => JSON.stringify(pool.queries.latestMachineSession(JSON.parse(eligibleMachineKey.get()) as string[]) ?? null))
    const recentMachine = computed(() => JSON.parse(recentMachineKey.get()) as { machineId: string; createdAt: string } | null)
    const repositoryAt = keyedComputed('launch.repositoryAt', (path: string) =>
      reposToViews(headerEntities(pool).repositoryGroup(path).flatMap(id => {
        const row = pool.row('repository', id) as GitRepositoryWire | undefined
        return row && typeof row !== 'symbol' ? [row] : []
      }))[0])
    const origin = keyedComputed('launch.origin', (path: string) => {
      const hosts = machines.get()
      return { repo: repositoryAt(path), machines: hosts }
    })
    const activityRoots = keyedComputed('launch.activityRoots', (path: string) => {
      const repo = repositoryAt(path)
      return JSON.stringify(repo ? [repo.path, ...repo.worktrees.map(tree => tree.path)] : [])
    })
    const activityAt = keyedComputed('launch.activityAt', (path: string) =>
      pool.queries.activity({ kind: 'commandRootActivity', roots: JSON.parse(activityRoots(path)) as string[], match: 'exact' }))
    const work = computed(() => {
      const choices = projects.get()
      return {
        machines: machines.get(),
        repos: choices,
        recentMachine: recentMachine.get() ?? undefined,
      }
    })
    return {
      repositoryPaths: () => paths.get(),
      newWork: () => work.get(),
      catalog: () => catalog.get(),
      picker: (): LaunchCatalogPicker => new LaunchCatalogPicker(pool),
      repositoryActivity: (path: string) => activityAt(machinePathKey(path)),
      origin: (path: string) => origin(machinePathKey(path)),
      counts,
      dispose() {
        repository.clear()
        rootKey.clear()
        usage.clear()
        project.clear()
        repositoryAt.clear()
        origin.clear()
        activityRoots.clear()
        activityAt.clear()
        catalogRoot.clear()
        catalogRoots.clear()
        catalogUsage.clear()
      },
    }
  })
}

const EMPTY_PINS = { repos: [] as readonly string[], worktrees: [] as readonly string[] }

/** New-task choices take recency once; host eligibility and catalog edits stay live.
 * The launcher's repositoryPaths/newWork ordering has a separate owner. */
export class LaunchCatalogPicker {
  @observableRef accessor order: string[] = []
  @observable accessor opened = false
  @observable accessor initialRepoPath = ''
  constructor(private readonly pool: MobxPool) {}
  @action open() {
    const catalog = launchOptionViews(this.pool).catalog()
    this.order = catalog.repoPaths
    this.initialRepoPath = catalog.initialRepoPath
    this.opened = true
  }
  @lazy get repoPaths() {
    const paths = headerEntities(this.pool).repositoryRootIds()
      .flatMap(id => {
        const row = this.pool.row('repository', id) as GitRepositoryWire | undefined
        return row && typeof row !== 'symbol' && row.kind !== 'worktree' ? [row.path] : []
      })
    const present = new Set(paths)
    return [...this.order.filter(path => present.has(path)), ...paths.filter(path => !this.order.includes(path))]
  }
  @lazy get data() {
    return { initialRepoPath: this.initialRepoPath, repoPaths: this.repoPaths, machines: headerView(this.pool).machines() }
  }
  catalog() { return this.data }
}
export const createLaunchCatalogPicker = (pool: MobxPool) => new LaunchCatalogPicker(pool)
