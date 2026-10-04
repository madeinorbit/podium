import {
  compareStructural,
  computed,
  createAtom,
  type IAtom,
  type IComputedValue,
  observable,
  runInAction,
} from 'mobx'
import { residentIds } from './enumerate'
import type { MobxPool } from './pool'
import { type ColdIndex, type ColdQueries, createColdIndex } from './shared/cold-index'
import { questionEntity, type ReaderQuestion } from './shared/reader-questions'
import type { ModelSchema } from './shared/schema'
import type { SessionActivityQuestion } from './shared/session-activity'
import type { RowSourceEvent } from './shared/source'
import { LOADING } from './worklist/rollup'

/** Query bridge, not a history index in the pool. Production questions go to
 * the row source. Directly-fed pools (fixtures/standalone consumers) use the
 * same feed index as a substitute source, never the residency registry. */
export class ReaderQueries {
  private readonly sessionsChanged = observable.box(0)
  private readonly standalone: ColdIndex | undefined
  private sessionVersion = -1
  private readonly activityRows = new Map<
    string,
    IComputedValue<{ cwd: string; at: number; collapsed: boolean } | undefined>
  >()
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
    if (event.type === 'replace') this.activityRows.clear()
    for (const row of event.rows) {
      if (row.kind === 'session' && !this.pool.tables.session.has(row.id))
        this.activityRows.delete(row.id)
    }
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
  /** The row source's candidates alone, for an identity facet no pool-side
   * edit can change: a session's server-assigned birth reference. The source
   * files every row it emits, overlaid spawn placeholders included, so the
   * resident union `ids` adds would only enumerate every resident session. */
  indexed(question: Extract<ReaderQuestion, { kind: 'sessionReference' }>): string[] {
    const index = this.watch(JSON.stringify(question), (value) => value.readerRevision(question))
    const ids = index.readerIds(question)
    this.counts.questions++
    this.counts.returnedIds += ids.length
    return ids
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
  activity(question: SessionActivityQuestion): number {
    const index = this.watch(JSON.stringify(question), (value) =>
      value.readerActivityRevision(question),
    )
    const resident = residentIds(this.pool, 'session')
    let latest = index.readerActivity({
      ...question,
      excluded: [...resident, ...(question.excluded ?? [])],
    })
    const excluded = new Set(question.excluded)
    for (const id of resident) {
      if (excluded.has(id)) continue
      let input = this.activityRows.get(id)
      if (!input) {
        input = computed(
          () => {
            const row = this.pool.row('session', id, 'summary-fields') as
              | { cwd: string; lastActiveAt?: string }
              | typeof LOADING
              | undefined
            return !row || row === LOADING
              ? undefined
              : {
                  cwd: row.cwd,
                  at: Date.parse(row.lastActiveAt ?? '') || 0,
                  collapsed: this.collapsed(id),
                }
          },
          { equals: compareStructural },
        )
        this.activityRows.set(id, input)
      }
      const row = input.get()
      if (!row || row.collapsed) continue
      if (
        !question.roots.some(
          (root) =>
            row.cwd === root || (question.match !== 'exact' && row.cwd?.startsWith(`${root}/`)),
        )
      )
        continue
      latest = Math.max(latest, row.at)
    }
    return latest
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
    this.activityRows.clear()
  }
}
