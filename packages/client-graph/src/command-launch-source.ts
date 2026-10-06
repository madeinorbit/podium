import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { machinePathKey } from '@podium/model'
import { normalizeOriginUrl } from '@podium/model/browser'
import { compareStructural, computed, observable, observe, runInAction } from 'mobx'
import {
  COMMAND_ENTITIES,
  COMMAND_LAUNCH_SCHEMA,
  COMMAND_RELATIONS,
  type CommandEntity,
  type CommandLaunchRows,
} from './command-launch-schema'
import { allResidentSessions } from './enumerate'
import type { MobxPool } from './pool'
import { RelationBuckets } from './relations'
import { createFieldInputs } from './shared/field-inputs'
import { defineSource, type PoolSource, type PoolSourceRows } from './source-registry'
import type { Loaded } from './worklist/rollup'

/** A read-side extension of the ONE pool. No sessions/issue viewmodel array is
 * acquired from the runtime, and only resident session rows enter the indexes. */
export class CommandLaunchSource implements PoolSource<CommandEntity> {
  private readonly tables = Object.fromEntries(
    COMMAND_ENTITIES.map((entity) => [
      entity,
      observable.map<string, object>(undefined, { deep: false }),
    ]),
  ) as Record<CommandEntity, ReturnType<typeof observable.map<string, object>>>
  private readonly orders = observable.map<CommandEntity, readonly string[]>(undefined, {
    deep: false,
  })
  private readonly relations = new RelationBuckets()
  private worktreesByPath = new Map<string, string[]>()
  private repositoriesByRoot = new Map<string, string[]>()
  /** Resident sessions by their cwd and every '/'-prefix of it: a discovery
   *  re-links only the sessions under a path whose targets moved. */
  private readonly sessionsByPath = new Map<string, Set<string>>()
  private readonly sessionCwd = new Map<string, string>()
  private readonly stops: (() => void)[] = []
  private readonly source = defineSource({
    readById: this.readById.bind(this),
    release: this.release.bind(this),
  })
  private get disposed(): boolean { return this.source.disposed }
  readonly counts = {
    publications: 0,
    windowChanges: 0,
    repoChanges: 0,
    sessionChanges: 0,
    sessionLinks: 0,
  }
  private readonly catalog

  constructor(
    private readonly pool: MobxPool,
    runtime: ClientRuntime<PodiumClientApi>,
  ) {
    this.catalog = computed(
      (): CommandLaunchRows['commandCatalog'] => ({
        repositories: this.orders.get('commandRepository') ?? [],
        repos: this.orders.get('commandRepo') ?? [],
        worktrees: this.orders.get('commandWorktree') ?? [],
        machines: this.orders.get('commandMachine') ?? [],
        issues: pool.queries.ids({ kind: 'commandIssues' }).sort(),
        sessions: this.sessionOrder(),
      }),
      { equals: compareStructural },
    )
    // Keyed (POD-5433): the window wakes on its own locals; machines and
    // repos arrive by id, and a repo change re-links only the sessions under
    // a path whose targets moved.
    const windowKeys = COMMAND_LAUNCH_SCHEMA.commandWindow.fields
    const inputs = createFieldInputs<CommandLaunchRows['commandWindow']>(
      windowKeys,
      {},
      'commandWindow',
    )
    const locals = (changed?: ReadonlySet<string>) => {
      if (this.disposed) return
      this.counts.publications++
      runInAction(() => {
        let moved = false
        for (const key of windowKeys)
          if (!changed || changed.has(key)) moved = inputs.set(key, runtime.readLocal(key)) || moved
        if (moved) this.counts.windowChanges++
        if (!this.tables.commandWindow.has('window'))
          this.replace('commandWindow', [['window', inputs.row]])
        else if (moved) this.change('commandWindow', 'window', inputs.row)
      })
    }
    const repos = () => {
      if (this.disposed) return
      runInAction(() => {
        this.repositories(
          runtime.listIds('repos').flatMap((id) => runtime.listRow('repos', id) ?? []),
        )
        this.counts.repoChanges++
      })
    }
    const machines = () => {
      if (this.disposed) return
      runInAction(() =>
        this.replace(
          'commandMachine',
          runtime.listIds('machines').flatMap((id) => {
            const row = runtime.listRow('machines', id)
            return row ? [[id, row] as const] : []
          }),
        ),
      )
    }
    repos()
    machines()
    locals()
    // Attach links every resident member once; later only addressed rows and
    // the sessions under a moved discovery path are visited.
    runInAction(() => {
      for (const [id, row] of allResidentSessions(pool)) this.change('session', id, row)
    })
    this.stops.push(
      runtime.onLocals(windowKeys, locals),
      runtime.onList('repos', repos),
      runtime.onList('machines', machines),
      observe(pool.tables.session, (change) => {
        if (this.disposed) return
        this.counts.sessionChanges++
        runInAction(() =>
          this.change(
            'session',
            change.name,
            change.type === 'delete'
              ? undefined
              : (pool.row('session', change.name) as object | undefined),
          ),
        )
      }),
    )
  }

  private sessionOrder(): readonly string[] {
    return this.pool.queries
      .ids({ kind: 'commandSessions' })
      .filter((id) => !this.pool.queries.collapsed(id))
      .sort((a, b) => {
        const left = this.pool.queries.orderKey(a),
          right = this.pool.queries.orderKey(b)
        return left < right ? -1 : left > right ? 1 : 0
      })
  }

  private replace(entity: CommandEntity, rows: readonly (readonly [string, object])[]): void {
    const table = this.tables[entity],
      ids = rows.map(([id]) => id),
      next = new Set(ids)
    for (const id of this.orders.get(entity) ?? [])
      if (!next.has(id)) {
        table.delete(id)
        this.change(entity, id, undefined)
      }
    for (const [id, row] of rows) {
      if (compareStructural(table.get(id), row)) continue
      table.set(id, row)
      this.change(entity, id, row)
    }
    if (!compareStructural(this.orders.get(entity), ids)) this.orders.set(entity, ids)
  }

  /** Discovery is a small roster: its rows are rebuilt and compared (only a
   *  moved row is written). Sessions are re-linked only under the paths whose
   *  worktree or repository targets moved. */
  private repositories(repos: readonly Store['repos'][number][]): void {
    const linked = new Set(repos.flatMap((repo) => repo.worktrees.map((tree) => machinePathKey(tree.path))))
    const scans: [string, object][] = [],
      groups: [string, object][] = [],
      trees: [string, object][] = []
    const groupIds = new Set<string>()
    const worktreesByPath = new Map<string, string[]>(),
      repositoriesByRoot = new Map<string, string[]>()
    const add = (index: Map<string, string[]>, key: string, value: string) =>
      index.set(key, [...(index.get(key) ?? []), value])
    for (const discovery of repos) {
      const id = JSON.stringify([discovery.machineId ?? '', machinePathKey(discovery.path)])
      const origin = normalizeOriginUrl(discovery.originUrl)
      const groupId =
        discovery.repoId ??
        (origin || `__no_remote__:${discovery.machineId ?? ''}:${machinePathKey(discovery.path)}`)
      scans.push([id, { ...discovery, groupId, linked: linked.has(machinePathKey(discovery.path)) }])
      for (const root of [discovery.path, ...discovery.worktrees.map((tree) => tree.path)])
        add(repositoriesByRoot, root, id)
      if (linked.has(machinePathKey(discovery.path))) continue
      if (!groupIds.has(groupId)) {
        groupIds.add(groupId)
        groups.push([groupId, { id: groupId }])
      }
      for (const tree of [
        { path: discovery.path, branch: discovery.branch, isMain: true },
        ...discovery.worktrees.map((tree) => ({ ...tree, isMain: false })),
      ]) {
        const treeId = JSON.stringify([id, machinePathKey(tree.path)])
        trees.push([
          treeId,
          {
            path: tree.path,
            ...(tree.branch !== undefined ? { branch: tree.branch } : {}),
            repoPath: discovery.path,
            isMain: tree.isMain,
            ...(discovery.machineId ? { machineId: discovery.machineId } : {}),
            ...(discovery.repoId ? { repoId: discovery.repoId } : {}),
            repositoryId: id,
            groupId,
          },
        ])
        add(worktreesByPath, tree.path, treeId)
      }
    }
    const moved = new Set<string>()
    for (const [before, after] of [
      [this.worktreesByPath, worktreesByPath],
      [this.repositoriesByRoot, repositoriesByRoot],
    ] as const) {
      for (const [path, ids] of after)
        if (!compareStructural(before.get(path), ids)) moved.add(path)
      for (const path of before.keys()) if (!after.has(path)) moved.add(path)
    }
    this.worktreesByPath = worktreesByPath
    this.repositoriesByRoot = repositoriesByRoot
    this.replace('commandRepository', scans)
    this.replace('commandRepo', groups)
    this.replace('commandWorktree', trees)
    const affected = new Set<string>()
    for (const path of moved) for (const id of this.sessionsByPath.get(path) ?? []) affected.add(id)
    for (const id of affected) {
      this.counts.sessionLinks++
      this.change('session', id, this.pool.row('session', id) as object | undefined)
    }
  }

  /** Index a resident session under its cwd and each '/'-prefix of it. */
  private indexSession(id: string, row: Record<string, unknown> | undefined): void {
    const before = this.sessionCwd.get(id),
      cwd = typeof row?.cwd === 'string' && row.cwd ? row.cwd : undefined
    if (before === cwd) return
    const paths = (key: string) => {
      const out = [key]
      for (let at = key.indexOf('/'); at >= 0; at = key.indexOf('/', at + 1))
        out.push(key.slice(0, at))
      return out
    }
    if (before !== undefined)
      for (const path of paths(before)) {
        const set = this.sessionsByPath.get(path)
        set?.delete(id)
        if (set?.size === 0) this.sessionsByPath.delete(path)
      }
    if (cwd === undefined) {
      this.sessionCwd.delete(id)
      return
    }
    this.sessionCwd.set(id, cwd)
    for (const path of paths(cwd)) {
      const set = this.sessionsByPath.get(path) ?? new Set<string>()
      this.sessionsByPath.set(path, set)
      set.add(id)
    }
  }

  private targets(
    row: Record<string, unknown> | undefined,
    relation: (typeof COMMAND_RELATIONS)[number],
  ): readonly string[] {
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
    if (entity === 'session') this.indexSession(id, row as Record<string, unknown> | undefined)
    for (const relation of COMMAND_RELATIONS) {
      if (relation.from !== entity) continue
      const address = `${entity}:${id}:${relation.to}:${relation.name}`
      const next = this.targets(row as Record<string, unknown> | undefined, relation)
      this.relations.move(address, id, next, target => `${relation.to}:${target}:${relation.name}`)
    }
  }

  read<K extends CommandEntity>(entity: K, id: string): Loaded<PoolSourceRows[K]> {
    return this.source.read(entity, id) as Loaded<PoolSourceRows[K]>
  }

  private readById<K extends CommandEntity>(entity: K, id: string): Loaded<PoolSourceRows[K]> {
    if (entity === 'commandIssue')
      return this.pool.row('issue', id, 'summary') as Loaded<PoolSourceRows[K]>
    return (
      entity === 'commandCatalog' && id === 'catalog'
        ? this.catalog.get()
        : this.tables[entity].get(id)
    ) as Loaded<PoolSourceRows[K]>
  }
  related(entity: string, id: string, name: string): readonly string[] {
    return this.relations.many(`${entity}:${id}:${name}`)
  }
  dispose(): void {
    this.source.dispose()
  }

  private release(): void {
    for (const stop of this.stops) stop()
    runInAction(() => {
      for (const table of Object.values(this.tables)) table.clear()
      this.orders.clear()
      this.relations.clear()
    })
    this.worktreesByPath.clear()
    this.repositoriesByRoot.clear()
    this.sessionsByPath.clear()
    this.sessionCwd.clear()
  }
}

export function attachCommandLaunchSource(
  pool: MobxPool,
  runtime: ClientRuntime<PodiumClientApi>,
): CommandLaunchSource {
  const source = new CommandLaunchSource(pool, runtime)
  pool.sources.register(COMMAND_ENTITIES, source)
  return source
}
