import { launchRecords } from './launch-records'
import { isGone } from './lookup'
import { here } from './lookup'
import { omitGone } from './lookup'
import { lazy, keyedComputed } from '@podium/mobx-helpers'
import {
  machineViewsFromWire,
  usableMachines,
  type RepoNavView,
} from '@podium/client-core/values'
import { type GitRepositoryWire, machinePathBasename, machinePathKey, machinePathsEqual } from '@podium/model/browser'
import { action, computed, observable, observableRef, compareShallow } from 'mobx'
import { headerEntities } from './header-entities'
import type { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

/** Live repository/host metadata shared by launchers. Recency is read only
 * by a picker's open action, never by the open launcher's derived fields. */
export function launchOptionViews(pool: MobxPool) {
  return pool.sources.view('launch.options', () => {
    const counts = { repositoryBuilds: 0, usageQueries: 0 }
    const repository = keyedComputed('launch.repository', (id: string) => {
      counts.repositoryBuilds++
      return launchRecords(pool).group(id)
    })
    const machines = computed(() => headerEntities(pool).orders.get('machine')?.flatMap(id => here(pool.model('machine', id)) ?? []) ?? [...pool.tables.machine.keys()].flatMap(id => here(pool.model('machine', id)) ?? []), { equals: compareShallow })
    const pins = computed(() => {
      const row = omitGone(pool.row('commandWindow', 'window'))
      return row && row !== LOADING ? row.pins : EMPTY_PINS
    })
    const projectForRepository = (repo: NonNullable<ReturnType<typeof repository>>) => launchRecords(pool).byId(repo.id, true)!
    const project = keyedComputed('launch.project', (id: string) => launchRecords(pool).group(id, true))
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
    const origin = keyedComputed('launch.origin', (path: string) => new LaunchOrigin(pool, path))
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
  @lazy({ equals: compareShallow }) get roots() {
    return headerEntities(this.pool).repositoryRootIds().flatMap(id => here(this.pool.model('repository', id)) ?? [])
  }
  @lazy({ equals: compareShallow }) get repoPaths() {
    const paths = this.roots.flatMap(root => root.kind === 'worktree' ? [] : [root.path])
    return storedOrder(this.order, paths)
  }
  @lazy get machines() { return launchOptionViews(this.pool).machines() }
  catalog() { return this }
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
  @lazy({ equals: compareShallow }) get repositoryPaths() {
    const paths = headerEntities(this.pool).repositoryGroupIds()
      .flatMap(id => launchOptionViews(this.pool).repository(id)?.path ?? [])
    return storedOrder(this.pathOrder, paths)
  }
  @lazy get repositoryAnswer() {
    const window = this.pool.row('commandWindow', 'window')
    const catalog = this.pool.row('commandCatalog', 'catalog')
    if (isGone(window)) return window
    if (isGone(catalog)) return catalog
    if (window !== LOADING && window.reposLoaded === false) return LOADING
    // Before a source attaches, resident scans already answer nonempty choices.
    // An empty table answers only after authoritative membership has arrived.
    if (catalog === LOADING && !headerEntities(this.pool).orders.has('repository') && this.pool.tables.repository.size === 0) return LOADING
    return this.repositoryPaths
  }
  @lazy({ equals: compareShallow }) get choices() {
    const views = launchOptionViews(this.pool)
    return headerEntities(this.pool).repositoryGroupIds().flatMap(id => {
      const repo = views.project(id)
      return repo && views.projectIsEligible(repo) ? [repo] : []
    })
  }
  @lazy({ equals: compareShallow }) get repos() {
    const choices = this.choices
    return storedOrder(this.projectOrder, choices.map(repo => repo.path)).flatMap(path => {
      const repository = launchRecords(this.pool).at(path)
      return repository ? launchRecords(this.pool).byId(repository.id, true) ?? [] : []
    })
  }
  @lazy get machines() { return launchOptionViews(this.pool).machines() }
  @lazy get recentMachine() { return launchOptionViews(this.pool).recentMachine() }
  newWork() {
    // This whole-view accessor acquires launcher roster membership. Each host's
    // fields remain on its model, read by the small host option that shows it.
    void this.machines
    return this
  }
  repositoryActivity(path: string) { return this.usageAt.get(machinePathKey(path)) ?? 0 }
}
export const createLaunchWorkPicker = (pool: MobxPool) => new LaunchWorkPicker(pool)

function storedOrder(order: readonly string[], paths: readonly string[]): string[] {
  const present = new Set(paths), stored = new Set(order)
  return [...order.filter(path => present.has(path)), ...paths.filter(path => !stored.has(path))]
}

/** One launch opening addresses a repository by path; facts stay on models. */
export class LaunchOrigin {
  constructor(private readonly pool: MobxPool, readonly path: string) {}
  @lazy get repo() { return launchRecords(this.pool).at(this.path) }
  @lazy get machines() { return launchOptionViews(this.pool).machines() }
}
