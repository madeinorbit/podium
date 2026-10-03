import { createAtom, type IAtom, observable, runInAction } from 'mobx'
import { residentIds } from './enumerate'
import type { MobxPool } from './pool'
import { type ColdIndex, type ColdQueries, createColdIndex } from './shared/cold-index'
import { questionEntity, type ReaderQuestion } from './shared/reader-questions'
import type { ModelSchema } from './shared/schema'
import type { RowSourceEvent } from './shared/source'

/** Query bridge, not a history index in the pool. Production questions go to
 * the row source. Directly-fed pools (fixtures/standalone consumers) use the
 * same feed index as a substitute source, never the residency registry. */
export class ReaderQueries {
  private readonly sessionsChanged = observable.box(0)
  private readonly standalone: ColdIndex | undefined
  private sessionVersion = -1
  private readonly observed = new Map<
    string,
    { atom: IAtom; version: number; revision(index: ColdQueries): number }
  >()
  private readonly listeners = new Set<(event: RowSourceEvent) => void>()
  readonly counts = { questions: 0, returnedIds: 0 }
  constructor(
    private readonly pool: MobxPool,
    schema: ModelSchema,
    private readonly source?: () => ColdQueries,
  ) {
    if (!source) this.standalone = createColdIndex(schema)
  }
  private index(): ColdQueries {
    return this.source?.() ?? this.standalone!
  }
  private watch(key: string, revision: (index: ColdQueries) => number): ColdQueries {
    const index = this.index()
    let state = this.observed.get(key)
    if (!state) {
      state = {
        atom: createAtom(`history.${key}`, undefined, () => this.observed.delete(key)),
        version: revision(index),
        revision,
      }
      this.observed.set(key, state)
    }
    if (!state.atom.reportObserved()) this.observed.delete(key)
    return index
  }
  publish(event: RowSourceEvent): void {
    this.standalone?.apply(event)
    const index = this.index()
    for (const state of this.observed.values()) {
      const version = state.revision(index)
      if (state.version !== version) {
        state.version = version
        state.atom.reportChanged()
      }
    }
    if (this.sessionVersion !== index.sessionRevision) {
      this.sessionVersion = index.sessionRevision
      runInAction(() => this.sessionsChanged.set(this.sessionsChanged.get() + 1))
    }
    for (const listener of this.listeners) listener(event)
  }
  onChange(listener: (event: RowSourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  ids(question: ReaderQuestion): string[] {
    const index = this.watch(JSON.stringify(question), (value) => value.readerRevision(question)),
      entity = questionEntity(question)
    // Resident identities remain the pool's authority, including pending
    // edits that have not reached the feed. A query is a candidate set; the
    // reader checks its current fields through pool.row.
    const resident = residentIds(this.pool, entity)
    const coldQuestion =
      question.kind === 'headerRecentSession'
        ? { ...question, excluded: [...resident, ...(question.excluded ?? [])] }
        : question
    let ids = [...new Set([...resident, ...index.readerIds(coldQuestion)])]
    if (question.kind === 'headerRecentSession' && question.excluded?.length) {
      const excluded = new Set(question.excluded)
      ids = ids.filter((id) => !excluded.has(id))
    }
    this.counts.questions++
    this.counts.returnedIds += ids.length
    return entity === 'session' ? ids.sort() : ids
  }
  count(entity: 'issue' | 'session'): number {
    const question: ReaderQuestion = {
      kind: entity === 'issue' ? 'commandIssues' : 'commandSessions',
    }
    const index = this.watch(`count:${entity}`, (value) => value.readerRevision(question))
    return (
      index.count(entity) +
      residentIds(this.pool, entity).filter((id) => !index.known(entity, id)).length
    )
  }
  repoIds(): string[] {
    return this.watch('repos', (value) => value.issueRepoRevision).issueRepoIds()
  }
  collapsed(id: string): boolean {
    this.sessionsChanged.get()
    return this.index().sessionCollapsed(id)
  }
  orderKey(id: string): string {
    this.sessionsChanged.get()
    return this.index().sessionOrderKey(id)
  }
  dispose(): void {
    this.listeners.clear()
    this.observed.clear()
  }
}
