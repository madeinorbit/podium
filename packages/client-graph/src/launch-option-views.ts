import { omitGone } from './lookup'
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

/** Live repository/host metadata shared by launchers. Recency is read only
 * by a picker's open action, never by the open launcher's derived fields. */
export function launchOptionViews(pool: MobxPool) {
  return pool.sources.view('launch.options', () => {
    const counts = { repositoryBuilds: 0, usageQueries: 0 }
    const repository = keyedComputed('launch.repository', (id: string) => {
      counts.repositoryBuilds++
      const scans = headerEntities(pool)
        .repositoryGroupRoots(id)
        .flatMap((id) => {
          const row = omitGone(pool.row('repository', id)) as GitRepositoryWire | undefined
          return row && typeof row !== 'symbol' ? [row] : []
        })
      return reposToViews(scans)[0]
    })
    const machines = computed(() => headerView(pool).machines())
    const pins = computed(() => {
      const row = omitGone(pool.row('commandWindow', 'window'))
      return row && row !== LOADING ? row.pins : EMPTY_PINS
    })
    const projectForRepository = (repo: NonNullable<ReturnType<typeof repository>>): RepoNavView => {
      const pinned = pins.get().worktrees
      return { ...repo, worktrees: repo.worktrees.flatMap(tree =>
        pinned.some(path => machinePathsEqual(path, tree.path)) ? [] :
          [{ ...tree, repoName: repo.name, sessions: [], issues: [] }]) }
    }
    const project = keyedComputed('launch.project', (id: string): RepoNavView | undefined => {
      const repo = repository(id)
      return repo ? projectForRepository(repo) : undefined
    })
    const projectIsEligible = (repo: RepoNavView) =>
      pins.get().repos.some(path => machinePathsEqual(path, repo.path)) || repo.worktrees.length > 0
    const workOnOpen = (mode: LaunchWorkMode) => {
      const pinned = pins.get().repos
      const values = headerEntities(pool).repositoryGroupIds().flatMap(id => {
        const repo = repository(id)
        if (!repo) return []
        // One metadata read per group in the open action. Exact and within
        // are distinct visible order rules; neither remains observed.
        const roots = [repo.path, ...repo.worktrees.map(tree => tree.path)]
        const choice = projectForRepository(repo)
        const eligible = projectIsEligible(choice)
        const activity = (match: 'exact' | 'within') => {
          counts.usageQueries++
          return pool.queries.activity({ kind: 'commandRootActivity', roots, match })
        }
        return [{ repo, eligible, pathAt: mode === 'work' ? 0 : activity('within'),
          projectAt: mode === 'paths' || !eligible ? 0 : activity('exact') }]
      })
      const paths = mode === 'work' ? [] : [...values]
        .sort((a, b) => b.pathAt - a.pathAt || a.repo.path.localeCompare(b.repo.path, undefined, { sensitivity: 'base' }))
        .map(value => value.repo.path)
      const projects = mode === 'paths' ? [] : values.filter(value => value.eligible)
      const pinOrder = new Map(pinned.map((path, at) => [machinePathKey(path), at]))
      projects.sort((a, b) => b.projectAt - a.projectAt ||
        a.repo.name.localeCompare(b.repo.name, undefined, { sensitivity: 'base' }) ||
        (pinOrder.get(machinePathKey(a.repo.path)) ?? pinned.length) -
          (pinOrder.get(machinePathKey(b.repo.path)) ?? pinned.length))
      return { paths, projects: projects.map(value => value.repo.path),
        usageAt: new Map(projects.map(value => [machinePathKey(value.repo.path), value.projectAt])) }
    }
    const catalogRoot = keyedComputed('launch.catalogRoot', (id: string) => {
      const row = omitGone(pool.row('repository', id)) as GitRepositoryWire | undefined
      return row && typeof row !== 'symbol' ? row : undefined
    })
    const catalogOnOpen = () => {
      const values = headerEntities(pool).repositoryRootIds().flatMap(id => {
        const repo = catalogRoot(id)
        return repo && repo.kind !== 'worktree' ? [{ path: repo.path,
          at: pool.queries.activity({ kind: 'commandRootActivity', roots: [repo.path, ...repo.worktrees.map(tree => tree.path)] }),
        }] : []
      })
      // The default keeps discovery order on equal usage. Displayed choices
      // break ties by basename, as the existing New Issue dialog does.
      let initialRepoPath = values.reduce<(typeof values)[number] | undefined>((best, value) =>
        !best || value.at > best.at ? value : best, undefined)?.path
      if (initialRepoPath === undefined) {
        const id = headerEntities(pool).firstId('repository')
        initialRepoPath = id ? catalogRoot(id)?.path ?? '' : ''
      }
      values.sort((a, b) => b.at - a.at ||
        (machinePathBasename(a.path) || a.path).localeCompare(
          machinePathBasename(b.path) || b.path, undefined, { sensitivity: 'base' }))
      return { initialRepoPath, repoPaths: values.map(value => value.path) }
    }
    const eligibleMachineKey = computed(
      () => JSON.stringify(usableMachines(machineViewsFromWire(machines.get())).map((machine) => machine.id)),
    )
    const recentMachineKey = computed(() => JSON.stringify(pool.queries.latestMachineSession(JSON.parse(eligibleMachineKey.get()) as string[]) ?? null))
    const recentMachine = computed(() => JSON.parse(recentMachineKey.get()) as { machineId: string; createdAt: string } | null)
    const repositoryAt = keyedComputed('launch.repositoryAt', (path: string) =>
      reposToViews(headerEntities(pool).repositoryGroup(path).flatMap(id => {
        const row = omitGone(pool.row('repository', id)) as GitRepositoryWire | undefined
        return row && typeof row !== 'symbol' ? [row] : []
      }))[0])
    const origin = keyedComputed('launch.origin', (path: string) => {
      const hosts = machines.get()
      return { repo: repositoryAt(path), machines: hosts }
    })
    return {
      workOnOpen,
      catalogOnOpen,
      picker: (): LaunchCatalogPicker => new LaunchCatalogPicker(pool),
      repository: (id: string) => repository(id),
      project: (id: string) => project(id),
      projectIsEligible,
      machines: () => machines.get(),
      recentMachine: () => recentMachine.get() ?? undefined,
      origin: (path: string) => origin(machinePathKey(path)),
      counts,
      dispose() {
        repository.clear()
        project.clear()
        repositoryAt.clear()
        origin.clear()
        catalogRoot.clear()
      },
    }
  })
}

const EMPTY_PINS = { repos: [] as readonly string[], worktrees: [] as readonly string[] }

/** New-task recency belongs to this opening; host and catalog edits stay live. */
export class LaunchCatalogPicker {
  @observableRef accessor order: string[] = []
  @observable accessor opened = false
  @observable accessor initialRepoPath = ''
  constructor(private readonly pool: MobxPool) {}
  @action open() {
    const catalog = launchOptionViews(this.pool).catalogOnOpen()
    this.order = catalog.repoPaths
    this.initialRepoPath = catalog.initialRepoPath
    this.opened = true
  }
  @lazy get roots() {
    return headerEntities(this.pool).repositoryRootIds()
      .map(id => new LaunchCatalogRoot(this.pool, id))
  }
  @lazy get repoPaths() {
    const paths = this.roots.flatMap(root => root.path === undefined ? [] : [root.path])
    return storedOrder(this.order, paths)
  }
  @lazy get data() {
    return { initialRepoPath: this.initialRepoPath, repoPaths: this.repoPaths, machines: headerView(this.pool).machines() }
  }
  catalog() { return this.data }
}
export const createLaunchCatalogPicker = (pool: MobxPool) => new LaunchCatalogPicker(pool)

export type LaunchWorkMode = 'work' | 'paths' | 'both'

/** The phone launch sheet owns recency for one opening; repository metadata stays live. */
export class LaunchWorkPicker {
  @observableRef accessor pathOrder: string[] = []
  @observableRef accessor projectOrder: string[] = []
  @observableRef accessor usageAt: ReadonlyMap<string, number> = new Map()
  @observable accessor opened = false
  constructor(private readonly pool: MobxPool) {}
  @action open(mode: LaunchWorkMode = 'both') {
    const snapshot = launchOptionViews(this.pool).workOnOpen(mode)
    this.pathOrder = snapshot.paths
    this.projectOrder = snapshot.projects
    this.usageAt = snapshot.usageAt
    this.opened = true
  }
  @lazy get repositoryPaths() {
    const paths = headerEntities(this.pool).repositoryGroupIds()
      .flatMap(id => launchOptionViews(this.pool).repository(id)?.path ?? [])
    return storedOrder(this.pathOrder, paths)
  }
  @lazy get choices() {
    const views = launchOptionViews(this.pool)
    return headerEntities(this.pool).repositoryGroupIds().flatMap(id => {
      const repo = views.project(id)
      return repo && views.projectIsEligible(repo) ? [repo] : []
    })
  }
  @lazy get repos() {
    const choices = this.choices
    const byPath = new Map(choices.map(repo => [repo.path, repo]))
    return storedOrder(this.projectOrder, choices.map(repo => repo.path)).flatMap(path => byPath.get(path) ?? [])
  }
  @lazy get data() {
    const views = launchOptionViews(this.pool)
    return { machines: views.machines(), repos: this.repos, recentMachine: views.recentMachine() }
  }
  newWork() { return this.data }
  repositoryActivity(path: string) { return this.usageAt.get(machinePathKey(path)) ?? 0 }
}
export const createLaunchWorkPicker = (pool: MobxPool) => new LaunchWorkPicker(pool)

function storedOrder(order: readonly string[], paths: readonly string[]): string[] {
  const present = new Set(paths), stored = new Set(order)
  return [...order.filter(path => present.has(path)), ...paths.filter(path => !stored.has(path))]
}

/** A catalog choice observes its own path, not unrelated scan metadata. */
class LaunchCatalogRoot {
  constructor(private readonly pool: MobxPool, private readonly id: string) {}
  @lazy get path(): string | undefined {
    const row = omitGone(this.pool.row('repository', this.id)) as GitRepositoryWire | undefined
    return row && typeof row !== 'symbol' && row.kind !== 'worktree' ? row.path : undefined
  }
}
