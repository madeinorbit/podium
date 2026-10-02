import type { ClientRuntime, Store } from '@podium/client-core/engine'
import type { PodiumClientApi } from '@podium/client-core/api'
import { normalizeOriginUrl } from '@podium/model/browser'
import { compareStructural, computed, observable, observe, runInAction } from 'mobx'
import type { MobxPool } from './pool'
import { allResidentSessions, knownIssueIds, knownSessionIds } from './enumerate'
import { COMMAND_ENTITIES, COMMAND_RELATIONS, type CommandEntity, type CommandLaunchRows } from './command-launch-schema'
import type { PoolSource, PoolSourceRows } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

/** A read-side extension of the ONE pool. No sessions/issue viewmodel array is
 * acquired from the runtime, and only resident session rows enter the indexes. */
export class CommandLaunchSource implements PoolSource<CommandEntity> {
  private readonly tables = Object.fromEntries(COMMAND_ENTITIES.map(entity => [entity, observable.map<string, object>(undefined, { deep: false })])) as Record<CommandEntity, ReturnType<typeof observable.map<string, object>>>
  private readonly orders = observable.map<CommandEntity, readonly string[]>(undefined, { deep: false })
  private readonly members = observable.map<string, readonly string[]>(undefined, { deep: false })
  private readonly edges = new Map<string, readonly string[]>()
  private readonly worktreesByPath = new Map<string, string[]>()
  private readonly repositoriesByRoot = new Map<string, string[]>()
  private readonly stops: (() => void)[] = []
  private previousRepos?: Store['repos']
  private previousMachines?: Store['machines']
  private disposed = false
  readonly counts = { publications: 0, windowChanges: 0, repoChanges: 0, sessionChanges: 0 }
  private readonly catalog

  constructor(private readonly pool: MobxPool, runtime: ClientRuntime<PodiumClientApi>) {
    this.catalog = computed((): CommandLaunchRows['commandCatalog'] => ({
      repositories: this.orders.get('commandRepository') ?? [], repos: this.orders.get('commandRepo') ?? [],
      worktrees: this.orders.get('commandWorktree') ?? [], machines: this.orders.get('commandMachine') ?? [],
      issues: knownIssueIds(pool).sort(), sessions: knownSessionIds(pool).filter(id => {
        // Collapse maintenance is keyed, not an observable collection. Track
        // each addressed row through the one reader so a changed twin reranks
        // the catalog even when its key set stays the same.
        pool.row('session', id, 'summary')
        return !pool.graph.isCollapsed('session', id)
      }),
    }), { equals: compareStructural })
    const locals = () => {
      if (this.disposed) return
      const state = runtime.getSnapshot()
      this.counts.publications++
      runInAction(() => {
        if (this.previousRepos !== state.repos) {
          this.previousRepos = state.repos
          this.repositories(state.repos)
          this.counts.repoChanges++
        }
        if (this.previousMachines !== state.machines) {
          this.previousMachines = state.machines
          this.replace('commandMachine', state.machines.map(machine => [machine.id, machine]))
        }
        const window: CommandLaunchRows['commandWindow'] = { paletteOpen: state.paletteOpen, pins: state.pins,
          selectedIssueId: state.selectedIssueId, openIssueId: state.openIssueId, selectedWorktree: state.selectedWorktree,
          paneA: state.paneA, recentFiles: state.recentFiles, sidebarSettings: state.sidebarSettings }
        if (!compareStructural(this.tables.commandWindow.get('window'), window)) this.counts.windowChanges++
        this.replace('commandWindow', [['window', window]])
      })
    }
    locals()
    this.stops.push(runtime.subscribe(locals), observe(pool.tables.session, change => {
      if (this.disposed) return
      this.counts.sessionChanges++
      runInAction(() => this.change('session', change.name, change.type === 'delete' ? undefined : pool.row('session', change.name) as object | undefined))
    }))
  }

  private replace(entity: CommandEntity, rows: readonly (readonly [string, object])[]): void {
    const table = this.tables[entity], ids = rows.map(([id]) => id), next = new Set(ids)
    for (const id of this.orders.get(entity) ?? []) if (!next.has(id)) { table.delete(id); this.change(entity, id, undefined) }
    for (const [id, row] of rows) {
      if (compareStructural(table.get(id), row)) continue
      table.set(id, row)
      this.change(entity, id, row)
    }
    if (!compareStructural(this.orders.get(entity), ids)) this.orders.set(entity, ids)
  }

  private repositories(repos: Store['repos']): void {
    const linked = new Set(repos.flatMap(repo => repo.worktrees.map(tree => tree.path)))
    const scans: [string, object][] = [], groups: [string, object][] = [], trees: [string, object][] = []
    this.worktreesByPath.clear(); this.repositoriesByRoot.clear()
    const add = (index: Map<string, string[]>, key: string, value: string) => index.set(key, [...(index.get(key) ?? []), value])
    for (const discovery of repos) {
      const id = JSON.stringify([discovery.machineId ?? '', discovery.path])
      const origin = normalizeOriginUrl(discovery.originUrl)
      const groupId = discovery.repoId ?? (origin || `__no_remote__:${discovery.machineId ?? ''}:${discovery.path}`)
      scans.push([id, { ...discovery, groupId, linked: linked.has(discovery.path) }])
      for (const root of [discovery.path, ...discovery.worktrees.map(tree => tree.path)]) add(this.repositoriesByRoot, root, id)
      if (linked.has(discovery.path)) continue
      if (!groups.some(([key]) => key === groupId)) groups.push([groupId, { id: groupId }])
      for (const tree of [{ path: discovery.path, branch: discovery.branch, isMain: true }, ...discovery.worktrees.map(tree => ({ ...tree, isMain: false }))]) {
        const treeId = JSON.stringify([id, tree.path])
        trees.push([treeId, { path: tree.path, ...(tree.branch !== undefined ? { branch: tree.branch } : {}),
          repoPath: discovery.path, isMain: tree.isMain, ...(discovery.machineId ? { machineId: discovery.machineId } : {}),
          ...(discovery.repoId ? { repoId: discovery.repoId } : {}), repositoryId: id, groupId }])
        add(this.worktreesByPath, tree.path, treeId)
      }
    }
    this.replace('commandRepository', scans); this.replace('commandRepo', groups); this.replace('commandWorktree', trees)
    // Discovery is a whole small roster change; re-link the resident members
    // once. Ordinary session publications only visit their addressed member.
    for (const [id, row] of allResidentSessions(this.pool)) this.change('session', id, row)
  }

  private targets(row: Record<string, unknown> | undefined, relation: typeof COMMAND_RELATIONS[number]): readonly string[] {
    if ('excludeShell' in relation && row?.agentKind === 'shell') return []
    const key = row?.[relation.key]
    if (typeof key !== 'string' || !key) return []
    if ('match' in relation) {
      if (relation.match === 'exact-worktree') return this.worktreesByPath.get(key) ?? []
      const ids = new Set(this.repositoriesByRoot.get(key) ?? [])
      for (let at = key.indexOf('/'); at >= 0; at = key.indexOf('/', at + 1)) {
        for (const id of this.repositoriesByRoot.get(key.slice(0, at)) ?? []) ids.add(id)
      }
      return [...ids]
    }
    return [key]
  }

  private change(entity: string, id: string, row: object | undefined): void {
    for (const relation of COMMAND_RELATIONS) {
      if (relation.from !== entity) continue
      const address = `${entity}:${id}:${relation.to}:${relation.name}`
      const previous = this.edges.get(address) ?? [], next = this.targets(row as Record<string, unknown> | undefined, relation)
      if (compareStructural(previous, next)) continue
      for (const target of previous) if (!next.includes(target)) {
        const key = `${relation.to}:${target}:${relation.name}`, ids = (this.members.get(key) ?? []).filter(member => member !== id)
        if (ids.length) this.members.set(key, ids); else this.members.delete(key)
      }
      for (const target of next) if (!previous.includes(target)) {
        const key = `${relation.to}:${target}:${relation.name}`
        this.members.set(key, [...(this.members.get(key) ?? []), id])
      }
      if (next.length) this.edges.set(address, next); else this.edges.delete(address)
    }
  }

  read<K extends CommandEntity>(entity: K, id: string): Loaded<PoolSourceRows[K]> {
    if (this.disposed) return LOADING
    if (entity === 'commandIssue') return this.pool.row('issue', id, 'summary') as Loaded<PoolSourceRows[K]>
    return (entity === 'commandCatalog' && id === 'catalog' ? this.catalog.get() : this.tables[entity].get(id)) as Loaded<PoolSourceRows[K]>
  }
  related(entity: string, id: string, name: string): readonly string[] { return this.members.get(`${entity}:${id}:${name}`) ?? [] }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    runInAction(() => { for (const table of Object.values(this.tables)) table.clear(); this.orders.clear(); this.members.clear() })
    this.edges.clear(); this.worktreesByPath.clear(); this.repositoriesByRoot.clear()
  }
}

export function attachCommandLaunchSource(pool: MobxPool, runtime: ClientRuntime<PodiumClientApi>): CommandLaunchSource {
  const source = new CommandLaunchSource(pool, runtime)
  pool.sources.register(COMMAND_ENTITIES, source)
  return source
}
