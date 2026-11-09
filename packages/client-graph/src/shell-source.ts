import type { ClientRuntime } from '@podium/client-core/engine'
import { lazy } from '@podium/mobx-helpers'
import { compareShallow, compareStructural, observable, runInAction } from 'mobx'
import { RelationBuckets } from './relations'
import { SHELL_RELATIONS, type ShellEntity, type ShellRows } from './shell-schema'
import { defineSource, type PoolSource } from './source-registry'
import type { Loaded } from './worklist/rollup'

const EMPTY_IDS: readonly string[] = Object.freeze([])

/** Read-side attachment. Locals are already authoritative engine values;
 * replica deltas read just the addressed lane, not the legacy ship collection. */
export class ShellSource implements PoolSource<ShellEntity> {
  private readonly window = Object.defineProperties(
    {},
    {
      ...Object.fromEntries(
        ['view', 'paneA', 'selectedIssueId', 'selectedWorktree', 'superOpen'].map((key) => [
          key,
          { enumerable: true, get: () => Reflect.get(this.runtime.ui, key) },
        ]),
      ),
      paletteOpen: { enumerable: true, get: () => this.runtime.palette.open },
      autoContinuePromptSessionId: {
        enumerable: true,
        get: () => this.runtime.autoContinueDialog.sessionId,
      },
    },
  ) as ShellRows['shellWindow']
  @lazy({ equals: compareShallow }) private get fileIds(): readonly string[] {
    return [...this.runtime.ui.fileTabs.keys()]
  }
  @lazy({ equals: compareShallow }) private get workspaceIds(): readonly string[] {
    return Object.keys(this.runtime.ui.workspaces)
  }
  // Each question follows only its own membership. Editing a workspace must
  // not rebuild the unchanged file list or wake its observers.
  private readonly screenCatalog = Object.defineProperties(
    {},
    {
      files: { enumerable: true, get: () => this.fileIds },
      workspaces: { enumerable: true, get: () => this.workspaceIds },
      lanes: { enumerable: true, get: () => this.orders.get('shellShipLane') ?? EMPTY_IDS },
    },
  ) as ShellRows['shellCatalog']

  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private readonly orders = observable.map<ShellEntity, readonly string[]>(undefined, {
    deep: false,
  })
  private readonly relations = new RelationBuckets()
  private readonly stops: (() => void)[]
  private readonly source = defineSource({
    readById: this.readById.bind(this),
    release: this.release.bind(this),
  })
  private get disposed(): boolean {
    return this.source.disposed
  }
  readonly counts = { locals: 0, laneCollections: 0, laneRows: 0 }

  constructor(
    private readonly runtime: Pick<ClientRuntime, 'ui' | 'palette' | 'autoContinueDialog' | 'root'>,
  ) {
    const lanes = () => {
      this.counts.laneCollections++
      this.replace(
        'shellShipLane',
        runtime.root.replica.rows('shipLanes').map((row) => [row.id, row]),
      )
      this.catalog()
    }
    runInAction(lanes)
    if (!runtime.root.replica.row || !runtime.root.replica.subscribeAddressedBatch)
      throw new Error('Shell controls require the existing addressed replica')
    this.stops = [
      runtime.root.replica.subscribeAddressedBatch((batch) => {
        if (this.disposed) return
        runInAction(() => {
          if (batch.type === 'replace') {
            lanes()
            return
          }
          for (const address of batch.rows)
            if (address.kind === 'shipLanes') {
              this.change(
                'shellShipLane',
                address.id,
                runtime.root.replica.row!('shipLanes', address.id),
              )
              this.counts.laneRows++
            }
          const laneIds = this.orders.get('shellShipLane') ?? []
          const ordered = [...laneIds].sort()
          if (!compareStructural(laneIds, ordered)) this.orders.set('shellShipLane', ordered)
          this.catalog()
        })
      }),
    ]
  }

  private change(entity: ShellEntity, id: string, next: object | undefined): void {
    const address = `${entity}:${id}`
    if (compareStructural(this.rows.get(address), next)) return
    if (next) this.rows.set(address, next)
    else this.rows.delete(address)
    const order = this.orders.get(entity) ?? []
    if (!next && order.includes(id))
      this.orders.set(
        entity,
        order.filter((key) => key !== id),
      )
    else if (next && !order.includes(id)) this.orders.set(entity, [...order, id])
    for (const relation of SHELL_RELATIONS) {
      if (relation.from !== entity) continue
      const value = next && Reflect.get(next, relation.key)
      const targets = typeof value === 'string' && value ? [value] : []
      this.relations.move(
        `${address}:${relation.name}`,
        id,
        targets,
        (target) => `${relation.to}:${target}:${relation.name}`,
      )
    }
  }
  private replace(entity: ShellEntity, entries: readonly (readonly [string, object])[]): void {
    const next = entries.map(([id]) => id),
      keep = new Set(next)
    for (const id of this.orders.get(entity) ?? [])
      if (!keep.has(id)) this.change(entity, id, undefined)
    for (const [id, row] of entries) this.change(entity, id, row)
    if (!compareStructural(this.orders.get(entity), next)) this.orders.set(entity, next)
  }
  private catalog(): void {
    this.change('shellCatalog', 'catalog', {
      files: this.orders.get('shellFile') ?? [],
      workspaces: this.orders.get('shellWorkspace') ?? [],
      lanes: this.orders.get('shellShipLane') ?? [],
    })
  }
  read<E extends ShellEntity>(entity: E, id: string): Loaded<ShellRows[E]> {
    return this.source.read(entity, id) as Loaded<ShellRows[E]>
  }

  private readById<E extends ShellEntity>(entity: E, id: string): Loaded<ShellRows[E]> {
    if (entity === 'shellWindow') return this.window as ShellRows[E]
    if (entity === 'shellFile') return this.runtime.ui.fileTabs.get(id) as ShellRows[E] | undefined
    if (entity === 'shellWorkspace')
      return this.runtime.ui.workspaces[id] as ShellRows[E] | undefined
    if (entity === 'shellCatalog') return this.screenCatalog as ShellRows[E]
    return this.rows.get(`${entity}:${id}`) as ShellRows[E] | undefined
  }
  related(entity: string, id: string, name: string): readonly string[] {
    if (entity === 'issue' && name === 'files')
      return [...this.runtime.ui.fileTabs.values()]
        .filter((file) => file.issueId === id)
        .map((file) => file.id)
    const relation = SHELL_RELATIONS.find((value) => value.from === entity && value.name === name)
    return relation ? this.relations.many(`${relation.to}:${id}:${name}`) : []
  }
  dispose(): void {
    this.source.dispose()
  }

  private release(): void {
    for (const stop of this.stops) stop()
    runInAction(() => {
      this.rows.clear()
      this.orders.clear()
      this.relations.clear()
    })
  }
}
