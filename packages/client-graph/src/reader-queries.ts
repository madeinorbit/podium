import {
  compareStructural,
  computed,
  createAtom,
  type IAtom,
  type IComputedValue,
  observable,
  observe,
  runInAction,
  untracked,
} from 'mobx'
import { residentIds } from './enumerate'
import type { MobxPool } from './pool'
import { createKeyedAnswer, createQueryResult } from './query-result'
import type { ColdQueries } from './shared/cold-index'
import { questionEntity, type ReaderQuestion } from './shared/reader-questions'
import type { ModelSchema } from './shared/schema'
import type { SessionActivityQuestion } from './shared/session-activity'
import type { RowSourceEvent } from './shared/source'
import { LOADING, type Loaded } from './worklist/rollup'

interface IdentityResult {
  question: ReaderQuestion
  source: ColdQueries
  answer: ReturnType<typeof createKeyedAnswer<string>>
  nextOrder: number
}

/** Query bridge, not a history index in the pool. Production questions go to
 * the row source's cold index; a directly-fed pool (fixtures, standalone
 * consumers) answers from its own (`MobxPool.coldIndex`). */
export class ReaderQueries {
  private readonly sessionsChanged = observable.box(0)
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
  private readonly memberListeners = new Map<string, Set<(id: string | undefined) => void>>()
  private sourceSeen: ColdQueries | undefined
  private readonly identities = new Map<string, IdentityResult>()
  private readonly results = new Map<string, ReturnType<typeof createQueryResult<unknown>>>()
  // Only residents unknown to the effective source contribute this correction.
  // Existing question atoms publish changes; these sets add no tracking objects.
  // Hydration, eviction and optimistic table writes all pass these observers.
  private readonly extras = {
    issue: new Set<string>(),
    session: new Set<string>(),
  }
  private readonly stopTables: (() => void)[] = []
  readonly counts = { questions: 0, returnedIds: 0 }
  constructor(
    private readonly pool: MobxPool,
    _schema: ModelSchema,
    private readonly source: () => ColdQueries,
  ) {
    for (const entity of ['issue', 'session'] as const)
      this.stopTables.push(
        observe(pool.tables[entity], (change) => {
          this.correctCount(entity, change.name)
          this.updateIdentity(entity, change.name)
        }),
      )
  }
  private correctCount(entity: 'issue' | 'session', id: string): void {
    const before = this.extras[entity].has(id)
    const extra = this.pool.tables[entity].has(id) && !this.index().known(entity, id)
    if (extra) this.extras[entity].add(id)
    else this.extras[entity].delete(id)
    if (before !== extra) this.observed.get(`count:${entity}`)?.atom.reportChanged()
  }
  private sourceOnly(question: ReaderQuestion): boolean {
    return (
      question.kind === 'mobileIssueTargets' ||
      (question.kind === 'commandIssueSessions' &&
        (question.archived !== undefined || question.includeShells !== undefined))
    )
  }
  private includes(question: ReaderQuestion, id: string): boolean {
    return (
      (!this.sourceOnly(question) && this.pool.tables[questionEntity(question)].has(id)) ||
      this.index().readerContains(question, id)
    )
  }
  private updateIdentity(entity: 'issue' | 'session', id: string): void {
    for (const [key, result] of this.identities) {
      if (questionEntity(result.question) !== entity) continue
      const before = result.answer.has(id),
        after = this.includes(result.question, id)
      if (before === after) continue
      if (after) this.addIdentity(result, id)
      else result.answer.delete(id)
      this.observed.get(key)?.atom.reportChanged()
    }
  }
  private addIdentity(result: IdentityResult, id: string): void {
    const order =
      questionEntity(result.question) === 'session'
        ? id
        : String(result.nextOrder++).padStart(16, '0')
    result.answer.set(id, order, id)
  }
  private identityResult(question: ReaderQuestion, source: ColdQueries): IdentityResult {
    const result = { question, source, answer: createKeyedAnswer<string>(), nextOrder: 0 }
    for (const id of this.initialIds(question, source)) this.addIdentity(result, id)
    return result
  }
  private index(): ColdQueries {
    return this.source()
  }
  private watch(key: string, revision: (index: ColdQueries) => number): ColdQueries {
    const index = this.index()
    let state = this.observed.get(key)
    const created = state === undefined
    if (!state) {
      state = {
        atom: createAtom(`history.${key}`, undefined, () => {
          this.observed.delete(key)
          this.identities.delete(key)
        }),
        version: revision(index),
        revision,
      }
      this.observed.set(key, state)
    }
    if (!state.atom.reportObserved() && created) this.observed.delete(key)
    return index
  }
  publish(event: RowSourceEvent): void {
    if (event.type === 'replace') this.activityRows.clear()
    for (const row of event.rows) {
      if (row.kind === 'session' && !this.pool.tables.session.has(row.id))
        this.activityRows.delete(row.id)
    }
    const index = this.index()
    const fresh = this.sourceSeen !== undefined && this.sourceSeen !== index
    this.sourceSeen = index
    if (event.type === 'replace' || fresh) {
      for (const entity of ['issue', 'session'] as const) {
        this.extras[entity].clear()
        for (const id of residentIds(this.pool, entity)) this.correctCount(entity, id)
      }
    }
    for (const row of event.rows)
      if (row.kind === 'issue' || row.kind === 'session') {
        this.correctCount(row.kind, row.id)
        this.updateIdentity(row.kind, row.id)
      }
    for (const [key, state] of this.observed) {
      const version = state.revision(index)
      const result = this.identities.get(key)
      if (result && (event.type === 'replace' || result.source !== index)) {
        this.identities.set(key, this.identityResult(result.question, index))
        state.version = version
        state.atom.reportChanged()
      } else if (state.version !== version || fresh) {
        state.version = version
        // Identity questions are notified only by a membership delta below.
        // Counts and ordered windows still follow their declared revisions.
        if (!result) state.atom.reportChanged()
      }
    }
    if (this.sessionVersion !== index.sessionRevision) {
      this.sessionVersion = index.sessionRevision
      runInAction(() => this.sessionsChanged.set(this.sessionsChanged.get() + 1))
    }
    if (event.type === 'replace' || fresh) {
      const listeners = [...this.memberListeners.values()].flatMap((value) => [...value])
      for (const listener of listeners) listener(undefined)
    } else {
      for (const [relation, owner, member] of index.changes(event).buckets)
        for (const listener of [...(this.memberListeners.get(`${relation}:${owner}`) ?? [])])
          listener(member)
    }
    for (const listener of [...this.listeners]) listener(event)
  }
  onChange(listener: (event: RowSourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** A declared relation's keyed membership deltas, without waking every
   * other owner's query when a member moves. */
  onMembers(
    entity: 'issue' | 'session',
    owner: string,
    relation: string,
    listener: (id: string | undefined) => void,
  ): () => void {
    const key = `${entity}.${relation}:${owner}`
    let listeners = this.memberListeners.get(key)
    if (!listeners) {
      listeners = new Set()
      this.memberListeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.memberListeners.delete(key)
    }
  }
  /** Addressed membership in the source's declared relation. Maintenance
   * callers pair this with onMembers, rather than enumerating the bucket. */
  hasMember(entity: 'issue' | 'session', owner: string, relation: string, id: string): boolean {
    return this.index().relations.members(entity, owner, relation).has(id)
  }
  ids(question: ReaderQuestion): string[] {
    const key = JSON.stringify(question)
    const index = this.watch(key, (value) => value.readerRevision(question))
    // Ranked windows stay bounded in the source's existing index.
    if (question.kind === 'mobileIssueTargets' || question.kind === 'headerRecentSession') {
      const ids = this.initialIds(question, index)
      this.counts.questions++
      this.counts.returnedIds += ids.length
      return ids
    }
    let result = this.identities.get(key)
    if (!result) {
      result = this.identityResult(question, index)
      if (this.observed.has(key)) this.identities.set(key, result)
    }
    const ids = result.answer.snapshot()
    this.counts.questions++
    this.counts.returnedIds += ids.length
    // Legacy callers own their sorting/filtering array. The maintained answer
    // remains identities only, and is never re-derived for a payload change.
    return ids
  }
  private initialIds(question: ReaderQuestion, index: ColdQueries): string[] {
    const entity = questionEntity(question)
    // These predicates are answered by the effective source feed, including
    // its pending overlays. Adding every resident identity would break the
    // target window or the requested issue/archive/shell roster.
    if (this.sourceOnly(question)) return index.readerIds(question)
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
    return entity === 'session' ? ids.sort() : ids
  }
  /** A declared question's demanded row answers, maintained by changed key.
   * They use only pool.row in the caller, and disappear when unobserved. */
  project<T>(question: ReaderQuestion, name: string, read: (id: string) => Loaded<T>): Loaded<T[]> {
    const key = `${name}:${JSON.stringify(question)}`
    let result = this.results.get(key)
    if (!result) {
      result = createQueryResult<unknown>({
        name,
        ids: () => untracked(() => this.ids(question)),
        has: (id) => untracked(() => this.includes(question, id)),
        read,
        subscribe: (changed) => {
          const entity = questionEntity(question)
          const stopTable = observe(this.pool.tables[entity], (change) => changed(change.name))
          let source = this.index()
          const stopFeed = this.onChange((event) => {
            if (event.type === 'replace' || source !== this.index()) {
              source = this.index()
              changed(undefined)
            } else for (const row of event.rows) if (row.kind === entity) changed(row.id)
          })
          return () => {
            stopTable()
            stopFeed()
          }
        },
        released: () => this.results.delete(key),
      })
      this.results.set(key, result)
    }
    return result.get() as Loaded<T[]>
  }
  /** The row source's indexed candidates, including pending spawn rows. These
   * questions use the source's birth-reference and repository buckets without
   * enumerating every resident row. */
  indexed(question: Extract<ReaderQuestion, { kind: 'sessionReference' | 'spawnIssues' }>): string[] {
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
    return index.count(entity) + this.extras[entity].size
  }
  repoIds(repoPath?: string): string[] {
    const key = repoPath === undefined ? 'repos' : `repos.path:${JSON.stringify(repoPath)}`
    return this.watch(key, (value) =>
      repoPath === undefined
        ? value.issueRepoRevision
        : value.readerRevision({
            kind: 'mobileIssueTargets',
            repoPath,
            excludeId: '',
            query: '',
            limit: 0,
            prefixes: {},
          }),
    ).issueRepoIds(repoPath)
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
    for (const stop of this.stopTables) stop()
    for (const result of [...this.results.values()]) result.dispose()
    this.results.clear()
    this.identities.clear()
    this.listeners.clear()
    this.memberListeners.clear()
    this.observed.clear()
    this.activityRows.clear()
  }
}
