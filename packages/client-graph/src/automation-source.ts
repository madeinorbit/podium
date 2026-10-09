import { defineSource } from './source-registry'
import type { Replica } from '@podium/client-core/replica'
import { compareStructural, observable, observableRef, runInAction } from 'mobx'
import { AUTOMATION_RELATIONS, type AutomationEntity, type AutomationRows } from './automation-schema'
import { RelationBuckets } from './relations'
import { MobxPool } from './pool'
import { omitGone } from './lookup'
import type { RowRecord } from './shared/source'
import { LOADING, type Loaded } from './worklist/rollup'

/** The source retains membership IDs and links. All record facts live in the
 * owning pool's generic tables; standalone source callers get their own pool. */
export class AutomationSource {
  private readonly ids = { automation: new Set<string>(), automationRun: new Set<string>() }
  private readonly relations = new RelationBuckets({ trackedForward: true, sorted: true })
  @observable accessor loaded = false
  @observableRef accessor catalogRow: AutomationRows['automationCatalog'] | undefined = undefined
  private demanded = false
  private pool: MobxPool | undefined
  private ownsPool = false
  private readonly source = defineSource({
    readById: this.readById.bind(this), refresh: this.refresh.bind(this), release: this.release.bind(this),
  })
  private get disposed(): boolean { return this.source.disposed }
  private readonly off: () => void
  readonly counts = { batches: 0, addressedRows: 0 }

  constructor(private readonly replica: Replica) {
    if (!replica.row || !replica.subscribeAddressedBatch) throw new Error('Automations require the existing addressed replica')
    this.off = replica.subscribeAddressedBatch(batch => {
      if (!this.demanded || this.disposed) return
      runInAction(() => {
        if (batch.type === 'replace' || !this.loaded) { this.source.schedule(); return }
        const records: RowRecord[] = []
        for (const address of batch.rows) {
          if (address.kind !== 'automations' && address.kind !== 'automationRuns') continue
          const kind = address.kind === 'automations' ? 'automation' : 'automationRun'
          records.push({ kind, id: address.id, value: replica.row!(address.kind, address.id) as RowRecord['value'] })
          this.counts.addressedRows++
        }
        if (records.length) { this.install(records); this.catalog() }
      })
    })
  }

  /** PoolSources binds before publishing a source. A standalone pool, if
   * already demanded, is released when its records join the application pool. */
  attach(pool: MobxPool): void {
    if (this.pool === pool) return
    const previous = this.pool
    if (previous) {
      const records: RowRecord[] = []
      for (const kind of ['automation', 'automationRun'] as const) for (const id of this.ids[kind])
        records.push({ kind, id, value: omitGone(previous.row(kind, id)) as RowRecord['value'] })
      pool.apply({ type: 'update', rows: records })
      if (this.ownsPool) previous.dispose()
    }
    this.pool = pool
    this.ownsPool = false
  }

  private backing(): MobxPool {
    if (!this.pool) {
      this.pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
      this.ownsPool = true
    }
    return this.pool
  }

  read(entity: AutomationEntity, id: string): Loaded<AutomationRows[AutomationEntity]> {
    return this.source.read(entity, id)
  }
  private readById(entity: AutomationEntity, id: string): Loaded<AutomationRows[AutomationEntity]> {
    this.demanded = true
    if (!this.loaded) { this.source.schedule(); return LOADING }
    if (entity === 'automationCatalog') return id === 'catalog' ? this.catalogRow : undefined
    return omitGone(this.backing().row(entity, id))
  }
  relation(entity: string, id: string, name: string): string | undefined {
    return this.relations.one(`${entity}:${id}:${name}`)
  }
  related(entity: string, id: string, name: string): readonly string[] {
    return this.relations.many(`${entity}:${id}:${name}`)
  }
  private install(records: readonly RowRecord[]): void {
    this.backing().apply({ type: 'update', rows: [...records] })
    for (const record of records) {
      if (record.kind !== 'automation' && record.kind !== 'automationRun') continue
      if (record.value) this.ids[record.kind].add(record.id)
      else this.ids[record.kind].delete(record.id)
      for (const relation of AUTOMATION_RELATIONS) {
        if (relation.from !== record.kind) continue
        const value = record.value && Reflect.get(record.value, relation.key)
        this.relations.move(`${record.kind}:${record.id}:${relation.name}`, record.id,
          typeof value === 'string' && value ? [value] : [], target => `${relation.to}:${target}:${relation.inverse}`)
      }
    }
  }
  private catalog(): void {
    const value = { automations: [...this.ids.automation].sort(), runs: [...this.ids.automationRun].sort() }
    if (!compareStructural(this.catalogRow, value)) this.catalogRow = value
  }
  private refresh(): void {
    const definitions = this.replica.rows('automations'), runs = this.replica.rows('automationRuns')
    runInAction(() => {
      const records: RowRecord[] = []
      for (const [kind, rows] of [['automation', definitions], ['automationRun', runs]] as const) {
        const keep = new Set(rows.map(row => row.id))
        for (const id of this.ids[kind]) if (!keep.has(id)) records.push({ kind, id, value: undefined })
        for (const row of rows) records.push({ kind, id: row.id, value: row as RowRecord['value'] })
      }
      this.install(records)
      this.catalog()
      this.loaded = true
      this.counts.batches++
    })
  }
  dispose(): void { this.source.dispose() }
  private release(): void {
    this.off()
    if (this.ownsPool) this.pool?.dispose()
    queueMicrotask(() => runInAction(() => {
      this.ids.automation.clear(); this.ids.automationRun.clear()
      this.relations.clear(); this.catalogRow = undefined; this.loaded = false
    }))
  }
}
