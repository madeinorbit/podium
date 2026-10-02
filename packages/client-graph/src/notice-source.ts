import type { ClientRuntime } from '@podium/client-core/engine'
import { compareStructural, observable, runInAction } from 'mobx'
import { NOTICE_RELATIONS, type NoticeEntity, type NoticeRows } from './notice-schema'
import { LOADING, type Loaded } from './worklist/rollup'

type NoticeRuntime = Pick<ClientRuntime, 'replica' | 'outbox'>
type RecordEntity = 'messageRecord' | 'pendingInteraction' | 'outboxDeadLetter'

/** Read-side attachment to the existing replica/outbox. Only the pool reader
 * calls read. Initial demand and replacement coalesce into one microtask;
 * ordinary replica deltas read just their addressed rows. */
export class NoticeSource {
  private readonly rows = observable.map<string, object>(undefined, { deep: false })
  private readonly refs = new Map<string, string>()
  private readonly members = new Map<string, readonly string[]>()
  private readonly loaded = observable.box(false)
  private demanded = false
  private scheduled = false
  private replicaDirty = true
  private outboxDirty = true
  private disposed = false
  private readonly stops: (() => void)[]
  readonly counts = { batches: 0, collectionReads: 0, addressedRows: 0, outboxReads: 0 }

  constructor(private readonly runtime: NoticeRuntime) {
    const { replica, outbox } = runtime
    if (!replica.row || !replica.subscribeAddressedBatch) throw new Error('Notices require the existing addressed replica')
    this.stops = [replica.subscribeAddressedBatch(batch => {
      if (!this.demanded || this.disposed) return
      if (batch.type === 'replace' || !this.loaded.get()) {
        this.replicaDirty = true
        this.schedule()
        return
      }
      runInAction(() => {
        let changed = false
        for (const address of batch.rows) {
          if (address.kind !== 'messageRecords' && address.kind !== 'pendingInteractions') continue
          this.change(address.kind === 'messageRecords' ? 'messageRecord' : 'pendingInteraction', address.id,
            replica.row!(address.kind, address.id))
          this.counts.addressedRows++
          changed = true
        }
        if (changed) this.catalog()
      })
    }), outbox.subscribe(() => {
      if (!this.demanded || this.disposed) return
      this.outboxDirty = true
      this.schedule()
    })]
  }

  read<E extends NoticeEntity>(entity: E, id: string): Loaded<NoticeRows[E]> {
    if (this.disposed) return LOADING
    this.demanded = true
    if (!this.loaded.get()) { this.schedule(); return LOADING }
    return this.rows.get(`${entity}:${id}`) as NoticeRows[E] | undefined
  }

  private set(key: string, value: object): void {
    if (!compareStructural(this.rows.get(key), value)) this.rows.set(key, value)
  }

  private change(entity: RecordEntity, id: string, next: object | undefined): void {
    const address = `${entity}:${id}`
    if (compareStructural(this.rows.get(address), next)) return
    if (next) this.rows.set(address, next)
    else this.rows.delete(address)
    for (const relation of NOTICE_RELATIONS) {
      if (relation.from !== entity) continue
      const key = `${address}:${relation.name}`, previous = this.refs.get(key)
      const value = next && Reflect.get(next, relation.key)
      const current = typeof value === 'string' && value ? value : undefined
      if (previous === current) continue
      for (const target of new Set([previous, current])) {
        if (!target) continue
        const inverse = `${relation.to}:${target}:${relation.inverse}`
        const rest = (this.members.get(inverse) ?? []).filter(member => member !== id)
        if (target === current) rest.push(id)
        if (rest.length) this.members.set(inverse, rest)
        else this.members.delete(inverse)
        const summary = {
          messages: this.members.get(`session:${target}:messages`) ?? [],
          interactions: this.members.get(`session:${target}:interactions`) ?? [],
        }
        if (summary.messages.length || summary.interactions.length) this.set(`noticeSession:${target}`, summary)
        else this.rows.delete(`noticeSession:${target}`)
      }
      if (current) this.refs.set(key, current)
      else this.refs.delete(key)
    }
  }

  private replace(entity: RecordEntity, entries: readonly (readonly [string, object])[]): void {
    const keep = new Set(entries.map(([id]) => id))
    for (const key of this.rows.keys()) if (key.startsWith(`${entity}:`)) {
      const id = key.slice(entity.length + 1)
      if (!keep.has(id)) this.change(entity, id, undefined)
    }
    for (const [id, row] of entries) this.change(entity, id, row)
  }

  private catalog(): void {
    const ids = (kind: RecordEntity) => [...this.rows.keys()].filter(key => key.startsWith(`${kind}:`)).map(key => key.slice(kind.length + 1))
    this.set('noticeCatalog:catalog', { messages: ids('messageRecord'), interactions: ids('pendingInteraction'), deadLetters: ids('outboxDeadLetter') })
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      const records = this.replicaDirty ? this.runtime.replica.rows('messageRecords') : undefined
      const asks = this.replicaDirty ? this.runtime.replica.rows('pendingInteractions') : undefined
      const parked = this.outboxDirty ? this.runtime.outbox.deadLetters() : undefined
      this.replicaDirty = false
      this.outboxDirty = false
      if (records) this.counts.collectionReads += 2
      if (parked) this.counts.outboxReads++
      runInAction(() => {
        if (records) this.replace('messageRecord', records.map(row => [row.id, row]))
        if (asks) this.replace('pendingInteraction', asks.map(row => [row.id, row]))
        if (parked) {
          this.replace('outboxDeadLetter', parked.map(row => [row.entry.mutationId, row]))
          // Recovery preserves the existing outbox's order, including re-parks.
          this.catalog()
          const catalog = this.rows.get('noticeCatalog:catalog') as NoticeRows['noticeCatalog']
          this.set('noticeCatalog:catalog', { ...catalog, deadLetters: parked.map(row => row.entry.mutationId) })
        } else this.catalog()
        this.loaded.set(true)
        this.counts.batches++
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    queueMicrotask(() => runInAction(() => {
      this.rows.clear(); this.refs.clear(); this.members.clear(); this.loaded.set(false)
    }))
  }
}
