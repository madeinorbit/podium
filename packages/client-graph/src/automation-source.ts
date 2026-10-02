import type { Replica } from '@podium/client-core/replica'
import { compareStructural, observable, runInAction } from 'mobx'
import { AUTOMATION_RELATIONS, type AutomationEntity, type AutomationRows } from './automation-schema'
import { LOADING, type Loaded } from './worklist/rollup'

/** Borrow the existing replica rows at a batched demand boundary. Addressed
 * updates maintain resident relations from schema metadata, in one action.
 * There is no snapshot selector, feed, outbox, RPC or mutation owner here. */
export class AutomationSource {
  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private readonly refs = observable.map<string, string>(undefined, { deep: false })
  private readonly members = observable.map<string, readonly string[]>(undefined, { deep: false })
  private readonly loaded = observable.box(false)
  private scheduled = false
  private demanded = false
  private disposed = false
  private readonly off: () => void
  readonly counts = { batches: 0, addressedRows: 0 }

  constructor(private readonly replica: Replica) {
    if (!replica.row || !replica.subscribeAddressedBatch) throw new Error('Automations require the existing addressed replica')
    this.off = replica.subscribeAddressedBatch(batch => {
      if (!this.demanded || this.disposed) return
      runInAction(() => {
        if (batch.type === 'replace' || !this.loaded.get()) { this.schedule(); return }
        let changed = false
        for (const address of batch.rows) {
          if (address.kind !== 'automations' && address.kind !== 'automationRuns') continue
          const entity = address.kind === 'automations' ? 'automation' : 'automationRun'
          this.change(entity, address.id, replica.row!(address.kind, address.id))
          this.counts.addressedRows++
          changed = true
        }
        if (changed) this.catalog()
      })
    })
  }

  read(entity: AutomationEntity, id: string): Loaded<AutomationRows[AutomationEntity]> {
    if (this.disposed) return LOADING
    this.demanded = true
    if (!this.loaded.get()) { this.schedule(); return LOADING }
    return this.rows.get(`${entity}:${id}`) as AutomationRows[AutomationEntity] | undefined
  }

  relation(entity: string, id: string, name: string): string | undefined {
    return this.refs.get(`${entity}:${id}:${name}`)
  }
  related(entity: string, id: string, name: string): readonly string[] {
    return this.members.get(`${entity}:${id}:${name}`) ?? []
  }

  private change(entity: 'automation' | 'automationRun', id: string, next: object | undefined): void {
    const address = `${entity}:${id}`
    if (compareStructural(this.rows.get(address), next)) return
    if (next) this.rows.set(address, next)
    else this.rows.delete(address)
    for (const relation of AUTOMATION_RELATIONS) {
      if (relation.from !== entity) continue
      const key = `${address}:${relation.name}`, previous = this.refs.get(key)
      const value = next && Reflect.get(next, relation.key)
      const target = typeof value === 'string' && value ? value : undefined
      if (previous === target) continue
      if (previous) {
        const inverse = `${relation.to}:${previous}:${relation.inverse}`
        const rest = (this.members.get(inverse) ?? []).filter(member => member !== id)
        if (rest.length) this.members.set(inverse, rest)
        else this.members.delete(inverse)
      }
      if (target) {
        const inverse = `${relation.to}:${target}:${relation.inverse}`
        this.members.set(inverse, [...(this.members.get(inverse) ?? []), id].sort())
        this.refs.set(key, target)
      } else this.refs.delete(key)
    }
  }

  private catalog(): void {
    const ids = (kind: string) => [...this.rows.keys()].filter(key => key.startsWith(`${kind}:`)).map(key => key.slice(kind.length + 1)).sort()
    const value = { automations: ids('automation'), runs: ids('automationRun') }
    if (!compareStructural(this.rows.get('automationCatalog:catalog'), value)) this.rows.set('automationCatalog:catalog', value)
  }

  private schedule(): void {
    if (this.disposed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      const definitions = this.replica.rows('automations'), runs = this.replica.rows('automationRuns')
      runInAction(() => {
        const keep = new Set([...definitions.map(row => `automation:${row.id}`), ...runs.map(row => `automationRun:${row.id}`)])
        for (const key of this.rows.keys()) {
          if (key === 'automationCatalog:catalog' || keep.has(key)) continue
          const split = key.indexOf(':')
          this.change(key.slice(0, split) as 'automation' | 'automationRun', key.slice(split + 1), undefined)
        }
        for (const row of definitions) this.change('automation', row.id, row)
        for (const row of runs) this.change('automationRun', row.id, row)
        this.catalog()
        this.loaded.set(true)
        this.counts.batches++
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.off()
    queueMicrotask(() => runInAction(() => {
      this.rows.clear(); this.refs.clear(); this.members.clear(); this.loaded.set(false)
    }))
  }
}
