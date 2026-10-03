import { observable, runInAction } from 'mobx'
import { residentIds } from './enumerate'
import type { MobxPool } from './pool'
import { createColdIndex, type ColdIndex, type ColdQueries } from './shared/cold-index'
import { questionEntity, type ReaderQuestion } from './shared/reader-questions'
import type { ModelSchema } from './shared/schema'
import type { RowSourceEvent } from './shared/source'

/** Query bridge, not a history index in the pool. Production questions go to
 * the row source. Directly-fed pools (fixtures/standalone consumers) use the
 * same feed index as a substitute source, never the residency registry. */
export class ReaderQueries {
  private readonly changed = observable.box(0)
  private readonly standalone: ColdIndex | undefined
  private version = -1
  private readonly listeners = new Set<(event: RowSourceEvent) => void>()
  readonly counts = { questions: 0, returnedIds: 0 }
  constructor(private readonly pool: MobxPool, schema: ModelSchema, private readonly source?: () => ColdQueries) {
    if (!source) this.standalone = createColdIndex(schema)
  }
  private index(): ColdQueries { this.changed.get(); return this.source?.() ?? this.standalone! }
  publish(event: RowSourceEvent): void {
    this.standalone?.apply(event)
    const version = (this.source?.() ?? this.standalone!).readerVersion
    if (this.version !== version) {
      this.version = version
      runInAction(() => this.changed.set(this.changed.get() + 1))
    }
    for (const listener of this.listeners) listener(event)
  }
  onChange(listener: (event: RowSourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  ids(question: ReaderQuestion): string[] {
    const index = this.index(), entity = questionEntity(question)
    // Resident identities remain the pool's authority, including pending
    // edits that have not reached the feed. A query is a candidate set; the
    // reader checks its current fields through pool.row.
    const ids = [...new Set([...residentIds(this.pool, entity), ...index.readerIds(question)])]
    this.counts.questions++; this.counts.returnedIds += ids.length
    return entity === 'session' ? ids.sort() : ids
  }
  count(entity: 'issue' | 'session'): number { return Math.max(this.index().count(entity), this.pool.tables[entity].size) }
  repoIds(): string[] { return this.index().issueRepoIds() }
  collapsed(id: string): boolean { return this.index().sessionCollapsed(id) }
  orderKey(id: string): string { return this.index().sessionOrderKey(id) }
  dispose(): void { this.listeners.clear() }
}
