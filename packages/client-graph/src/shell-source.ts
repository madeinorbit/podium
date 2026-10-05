import type { ClientRuntime, KeyedListChange, KeyedListName } from '@podium/client-core/engine'
import { compareStructural, observable, runInAction } from 'mobx'
import { RelationBuckets } from './relations'
import { createFieldInputs } from './shared/field-inputs'
import { SHELL_RELATIONS, SHELL_SCHEMA, type ShellEntity, type ShellRows } from './shell-schema'
import type { PoolSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

/** Read-side attachment. Locals are already authoritative engine values;
 * replica deltas read just the addressed lane, not the legacy ship collection. */
export class ShellSource implements PoolSource<ShellEntity> {
  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private readonly orders = observable.map<ShellEntity, readonly string[]>(undefined, {
    deep: false,
  })
  private readonly relations = new RelationBuckets()
  private readonly stops: (() => void)[]
  private disposed = false
  readonly counts = { locals: 0, laneCollections: 0, laneRows: 0 }

  constructor(
    runtime: Pick<
      ClientRuntime,
      'readLocal' | 'onLocals' | 'onList' | 'listIds' | 'listRow' | 'replica'
    >,
  ) {
    // Keyed (POD-5433): the window wakes on its own locals; each list hands
    // over only the rows that changed, by id.
    const windowKeys = SHELL_SCHEMA.shellWindow.fields
    const inputs = createFieldInputs<ShellRows['shellWindow']>(windowKeys, {}, 'shellWindow')
    const window = (changed?: ReadonlySet<string>) => {
      if (this.disposed) return
      runInAction(() => {
        for (const key of windowKeys)
          if (!changed || changed.has(key)) inputs.set(key, runtime.readLocal(key))
        this.change('shellWindow', 'window', inputs.row)
        this.counts.locals++
      })
    }
    const lists = [
      ['shellApproval', 'approvals'],
      ['shellFile', 'fileTabs'],
      ['shellWorkspace', 'workspaces'],
    ] as const
    const list = (entity: ShellEntity, name: KeyedListName, change?: KeyedListChange) => {
      if (this.disposed) return
      runInAction(() => {
        if (change === undefined)
          this.replace(
            entity,
            runtime.listIds(name).map((id) => [id, runtime.listRow(name, id) as object]),
          )
        else {
          for (const id of change.ids)
            this.change(entity, id, runtime.listRow(name, id) as object | undefined)
          const ids = runtime.listIds(name)
          if (change.order && !compareStructural(this.orders.get(entity), ids))
            this.orders.set(entity, [...ids])
        }
        this.catalog()
      })
    }
    window()
    for (const [entity, name] of lists) list(entity, name)
    const lanes = () => {
      this.counts.laneCollections++
      this.replace(
        'shellShipLane',
        runtime.replica.rows('shipLanes').map((row) => [row.id, row]),
      )
      this.catalog()
    }
    runInAction(lanes)
    if (!runtime.replica.row || !runtime.replica.subscribeAddressedBatch)
      throw new Error('Shell controls require the existing addressed replica')
    this.stops = [
      runtime.onLocals(windowKeys, window),
      ...lists.map(([entity, name]) =>
        runtime.onList(name, (change) => list(entity, name, change)),
      ),
      runtime.replica.subscribeAddressedBatch((batch) => {
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
                runtime.replica.row!('shipLanes', address.id),
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
      this.relations.move(`${address}:${relation.name}`, id, targets,
        target => `${relation.to}:${target}:${relation.name}`)
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
      approvals: this.orders.get('shellApproval') ?? [],
      files: this.orders.get('shellFile') ?? [],
      workspaces: this.orders.get('shellWorkspace') ?? [],
      lanes: this.orders.get('shellShipLane') ?? [],
    })
  }
  read<E extends ShellEntity>(entity: E, id: string): Loaded<ShellRows[E]> {
    return this.disposed ? LOADING : (this.rows.get(`${entity}:${id}`) as ShellRows[E] | undefined)
  }
  related(entity: string, id: string, name: string): readonly string[] {
    const relation = SHELL_RELATIONS.find((value) => value.from === entity && value.name === name)
    return relation ? (this.relations.many(`${relation.to}:${id}:${name}`)) : []
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    runInAction(() => {
      this.rows.clear()
      this.orders.clear()
      this.relations.clear()
    })
  }
}
