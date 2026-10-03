import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { compareStructural, observable, runInAction } from 'mobx'
import { SHELL_RELATIONS, type ShellEntity, type ShellRows } from './shell-schema'
import type { PoolSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

/** Read-side attachment. Locals are already authoritative engine values;
 * replica deltas read just the addressed lane, not the legacy ship collection. */
export class ShellSource implements PoolSource<ShellEntity> {
  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private readonly orders = observable.map<ShellEntity, readonly string[]>(undefined, { deep: false })
  private readonly members = observable.map<string, readonly string[]>(undefined, { deep: false })
  private readonly refs = new Map<string, string>()
  private readonly stops: (() => void)[]
  private disposed = false
  readonly counts = { locals: 0, laneCollections: 0, laneRows: 0 }

  constructor(runtime: Pick<ClientRuntime, 'getSnapshot' | 'subscribe' | 'replica'>) {
    let previous: Pick<Store, 'approvals' | 'fileTabs' | 'workspaces'> | undefined
    const locals = () => {
      if (this.disposed) return
      const state = runtime.getSnapshot()
      runInAction(() => {
        const { view, paneA, selectedIssueId, selectedWorktree, reposLoaded, superOpen, paletteOpen, autoContinuePromptSessionId, coarseNow } = state
        this.change('shellWindow', 'window', { view, paneA, selectedIssueId, selectedWorktree, reposLoaded, superOpen, paletteOpen, autoContinuePromptSessionId, coarseNow })
        if (state.approvals !== previous?.approvals) this.replace('shellApproval', state.approvals.map(row => [row.id, row]))
        if (state.fileTabs !== previous?.fileTabs) this.replace('shellFile', state.fileTabs.map(row => [row.id, row]))
        if (state.workspaces !== previous?.workspaces) this.replace('shellWorkspace', Object.entries(state.workspaces))
        previous = { approvals: state.approvals, fileTabs: state.fileTabs, workspaces: state.workspaces }
        this.catalog()
        this.counts.locals++
      })
    }
    const lanes = () => {
      this.counts.laneCollections++
      this.replace('shellShipLane', runtime.replica.rows('shipLanes').map(row => [row.id, row]))
      this.catalog()
    }
    locals()
    runInAction(lanes)
    if (!runtime.replica.row || !runtime.replica.subscribeAddressedBatch) throw new Error('Shell controls require the existing addressed replica')
    this.stops = [runtime.subscribe(locals), runtime.replica.subscribeAddressedBatch(batch => {
      if (this.disposed) return
      runInAction(() => {
        if (batch.type === 'replace') { lanes(); return }
        for (const address of batch.rows) if (address.kind === 'shipLanes') {
          this.change('shellShipLane', address.id, runtime.replica.row!('shipLanes', address.id))
          this.counts.laneRows++
        }
        this.catalog()
      })
    })]
  }

  private change(entity: ShellEntity, id: string, next: object | undefined): void {
    const address = `${entity}:${id}`
    if (compareStructural(this.rows.get(address), next)) return
    if (next) this.rows.set(address, next); else this.rows.delete(address)
    const order = this.orders.get(entity) ?? []
    if (!next && order.includes(id)) this.orders.set(entity, order.filter(key => key !== id))
    else if (next && !order.includes(id)) this.orders.set(entity, [...order, id])
    for (const relation of SHELL_RELATIONS) {
      if (relation.from !== entity) continue
      const key = `${address}:${relation.name}`, previous = this.refs.get(key)
      const value = next && Reflect.get(next, relation.key), target = typeof value === 'string' && value ? value : undefined
      if (previous === target) continue
      for (const member of new Set([previous, target])) {
        if (!member) continue
        const bucket = `${relation.to}:${member}:${relation.name}`
        const rest = (this.members.get(bucket) ?? []).filter(key => key !== id)
        if (member === target) rest.push(id)
        if (rest.length) this.members.set(bucket, rest); else this.members.delete(bucket)
      }
      if (target) this.refs.set(key, target); else this.refs.delete(key)
    }
  }
  private replace(entity: ShellEntity, entries: readonly (readonly [string, object])[]): void {
    const next = entries.map(([id]) => id), keep = new Set(next)
    for (const id of this.orders.get(entity) ?? []) if (!keep.has(id)) this.change(entity, id, undefined)
    for (const [id, row] of entries) this.change(entity, id, row)
    if (!compareStructural(this.orders.get(entity), next)) this.orders.set(entity, next)
  }
  private catalog(): void {
    this.change('shellCatalog', 'catalog', { approvals: this.orders.get('shellApproval') ?? [], files: this.orders.get('shellFile') ?? [],
      workspaces: this.orders.get('shellWorkspace') ?? [], lanes: this.orders.get('shellShipLane') ?? [] })
  }
  read<E extends ShellEntity>(entity: E, id: string): Loaded<ShellRows[E]> {
    return this.disposed ? LOADING : this.rows.get(`${entity}:${id}`) as ShellRows[E] | undefined
  }
  related(entity: string, id: string, name: string): readonly string[] {
    const relation = SHELL_RELATIONS.find(value => value.from === entity && value.name === name)
    return relation ? this.members.get(`${relation.to}:${id}:${name}`) ?? [] : []
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    runInAction(() => { this.rows.clear(); this.orders.clear(); this.members.clear(); this.refs.clear() })
  }
}
