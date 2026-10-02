/** Measurement prototype only. Coarse MobX invalidation over borrowed plain tables.
 * The hand arm's schema-driven ingest, summaries and plain rule functions are reused.
 * No computed, observable entry, or reaction is attached to an unmounted row. */
import { compareStructural, computed, createAtom, runInAction, type IComputedValue } from 'mobx'
import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { DISABLED_READ_FENCE, type ReadFence } from '../../../shared/src/instrument/reads'
import type { RowSourceEvent } from '../../../shared/src/stats'
import { SCHEMA, allRelations, type EntityName } from '@podium/client-graph/shared/schema'
import type { RowView } from '@podium/client-graph/shared/row-view'
import { reseed } from '../../hand/pool/enumerate'
import { PoolRelations } from '../../hand/pool/relations'
import { isLinkSpec, linkInputs } from '../../hand/pool/relations'
import { Residency, type Schedule } from '../../hand/pool/residency'
import { createTables, ingestOut, ingestRecord, put, type IngestTarget } from '../../hand/pool/tables'
import { COLD_SESSION_FIELDS, HIDDEN_ISSUE_FIELDS } from '../../hand/pool/worklist/visible'
import { derive } from './derive'

export const LOADING = Symbol('lean.loading')
const entities = Object.keys(SCHEMA) as EntityName[]

export class LeanPool {
  readonly tables = createTables()
  readonly fenced: typeof this.tables
  readonly tableSignals = Object.fromEntries(entities.map((e) => [e, createAtom('')])) as Record<EntityName, ReturnType<typeof createAtom>>
  readonly relationSignals = new Map(allRelations().map(({ from, name }) => [`${from}.${name}`, createAtom('')]))
  readonly localSignal = createAtom('')
  readonly windowSignal = createAtom('')
  readonly residency: Residency
  readonly engine: PoolRelations
  readonly relations: ReturnType<ReadFence['wrapRelations']>
  readonly mounted = new Map<string, IComputedValue<RowView | undefined>>()
  readonly filing: IComputedValue<ReturnType<typeof derive>>
  private readonly target: IngestTarget
  private readonly off: (() => void)[]
  private disposed = false

  constructor(readonly source: RowSource, readonly locals: LocalsSource, reads = DISABLED_READ_FENCE, schedule?: Schedule) {
    if (!source.row) throw new Error('Lean prototype requires the batched per-row feed')
    this.fenced = reads.wrapTables(this.tables)
    this.residency = new Residency({
      schema: SCHEMA,
      hot: this.fenced,
      residentRow: (entity, id) => this.row(entity, id, 'mark') as object | undefined,
      load: (entity, id) => source.row!(entity, id),
      now: () => locals.get().coarseNow,
      summaries: Object.fromEntries(['issue', 'session'].map((entity) => [entity, [
        ...(entity === 'issue' ? HIDDEN_ISSUE_FIELDS : COLD_SESSION_FIELDS),
        ...allRelations().filter(({ from, relation }) => from === entity && isLinkSpec(relation) && relation.kind !== 'prefix').flatMap(({ relation }) => linkInputs(relation as Parameters<typeof linkInputs>[0])),
      ]])),
      asked: (entity) => this.tableSignals[entity].reportObserved(),
      peeked: (entity) => this.tableSignals[entity].reportObserved(),
      changed: (entity) => this.tableSignals[entity].reportChanged(),
      rewritten: (entity) => this.tableSignals[entity].reportChanged(),
      lanes: () => this.engine,
      ...(schedule ? { schedule } : {}),
    })
    this.engine = new PoolRelations({
      schema: SCHEMA,
      rows: this.fenced,
      roots: this.tables,
      present: (entity, id) => this.known(entity, id),
      read: (relation) => this.relationSignals.get(relation)?.reportObserved(),
      onIssuelessJoin: (collection, _target, member) => this.residency.laneJoined(collection, member),
    })
    this.relations = reads.wrapRelations(this.engine)
    // Ordinary relation indexes contain resident sources only. Cold rows have
    // declared summaries in Residency, and never get relation buckets of their own.
    const residentRelations = {
      changed: (entity: EntityName, id: string, prev: object | undefined, next: object | undefined) =>
        this.engine.changed(entity, id, prev, this.tables[entity].has(id) ? next : undefined),
      members: (entity: EntityName, id: string, relation: string) => this.engine.members(entity, id, relation),
    }
    this.target = { read: this.fenced, write: this.tables, relations: residentRelations, residency: this.residency }
    this.filing = computed(() => {
      this.localSignal.reportObserved()
      this.windowSignal.reportObserved()
      for (const signal of Object.values(this.tableSignals)) signal.reportObserved()
      for (const signal of this.relationSignals.values()) signal.reportObserved()
      return derive(this)
    })
    this.residency.onDue(() => this.hydrate())
    this.apply({ type: 'replace', rows: [...source.snapshot('session'), ...source.snapshot('issue'), ...source.snapshot('worktree')] })
    this.off = [source.subscribe((event) => this.apply(event)), locals.subscribe(() => runInAction(() => this.localSignal.reportChanged()))]
  }

  known(entity: EntityName, id: string): boolean {
    this.tableSignals[entity].reportObserved()
    return this.fenced[entity].has(id) || this.residency.isCold(entity, id)
  }

  /** The only row reader. Summary reads never fetch data; absent reads queue once. */
  row(entity: EntityName, id: string, absent: 'load' | 'summary' | 'mark' = 'load'): object | typeof LOADING | undefined {
    this.tableSignals[entity].reportObserved()
    const row = this.fenced[entity].get(id)
    if (row !== undefined) return row
    if (absent === 'summary') return this.residency.summary(entity, id)
    if (absent === 'mark') return undefined
    if (entity === 'issue' || entity === 'session') this.residency.request(entity, id)
    return LOADING
  }

  apply(event: RowSourceEvent): void {
    runInAction(() => {
      this.engine.begin()
      const out = ingestOut()
      if (event.type === 'replace') reseed(this.target, event.rows, out, this.residency)
      else for (const row of event.rows) ingestRecord(this.target, row, out)
      this.residency.settleLanes(this.target, out)
      for (const delta of out.deltas) this.tableSignals[delta.entity].reportChanged()
      for (const write of this.engine.lastWrites) this.relationSignals.get(write.relation)?.reportChanged()
    })
  }

  hydrate(): void {
    runInAction(() => {
      this.engine.begin()
      const out = ingestOut()
      for (const [entity, id] of this.residency.take()) {
        if (this.residency.isCold(entity, id)) this.residency.hydrate(this.target, entity, id, out)
        else {
          const value = this.source.row!(entity, id)
          if (value) put(this.target, entity, id, value, out)
        }
      }
      for (const delta of out.deltas) this.tableSignals[delta.entity].reportChanged()
      for (const write of this.engine.lastWrites) this.relationSignals.get(write.relation)?.reportChanged()
    })
  }

  /** Called by a mounted slot, and released when that slot leaves the window. */
  mountRow(id: string): IComputedValue<RowView | undefined> {
    let value = this.mounted.get(id)
    if (!value) {
      value = computed(() => this.filing.get().views.get(id), { equals: compareStructural })
      this.mounted.set(id, value)
      runInAction(() => this.windowSignal.reportChanged())
    }
    return value
  }
  setWindow(ids: readonly string[]): void {
    runInAction(() => { for (const id of ids) this.mountRow(id) })
  }
  unmountRow(id: string): void { this.mounted.delete(id) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.off) off()
    this.residency.clear()
    this.mounted.clear()
  }
}
