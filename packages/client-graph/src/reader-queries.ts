import { createAtom, type IAtom, observe, untracked } from 'mobx'
import { residentIds } from './enumerate'
import type { MobxPool } from './pool'
import { createKeyedAnswer, createQueryResult } from './query-result'
import type { ColdQueries } from './shared/cold-index'
import { createReaderIndex, questionEntity, type ReaderQuestion } from './shared/reader-questions'
import type { ModelSchema } from './shared/schema'
import type { SessionActivityQuestion } from './shared/session-activity'
import type { SessionQuestions } from './shared/session-questions'
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
  private readonly sessionAtoms = new Map<string, IAtom>()
  private effectiveSessions: SessionQuestions | undefined
  private effectiveSource: ColdQueries | undefined
  private readonly observed = new Map<
    string,
    { atom: IAtom; version: number; revision(index: ColdQueries): number }
  >()
  private readonly listeners = new Set<(event: RowSourceEvent) => void>()
  private readonly memberListeners = new Map<string, Set<(id: string | undefined) => void>>()
  private sourceSeen: ColdQueries | undefined
  private readonly identities = new Map<string, IdentityResult>()
  /** Resident edits shadow the source by address. Predicate membership is
   * maintained at ingestion, never discovered by walking resident history. */
  private readonly residents = createReaderIndex({ targetSearch: false, recent: false })
  private readonly residentIssueIds = new Set<string>()
  private readonly results = new Map<string, ReturnType<typeof createQueryResult<unknown>>>()
  // Only residents unknown to the effective source contribute this correction.
  // Existing question atoms publish changes; these sets add no tracking objects.
  // Hydration, eviction and optimistic table writes all pass these observers.
  private readonly extras = {
    issue: new Set<string>(),
    session: new Set<string>(),
  }
  private readonly stopTables: (() => void)[] = []
  readonly counts = { questions: 0, returnedIds: 0, scalarVisits: 0 }
  constructor(
    private readonly pool: MobxPool,
    _schema: ModelSchema,
    private readonly source: () => ColdQueries,
  ) {
    for (const entity of ['issue', 'session'] as const)
      this.stopTables.push(
        observe(pool.tables[entity], (change) => {
          this.updateResident(entity, change.name)
          this.correctCount(entity, change.name)
          this.updateIdentity(entity, change.name)
        }),
      )
  }
  private updateResident(entity: 'issue' | 'session', id: string): void {
    const present = this.pool.tables[entity].has(id)
    if (entity === 'issue') {
      if (present) this.residentIssueIds.add(id)
      else this.residentIssueIds.delete(id)
    }
    const row = present ? untracked(() => this.pool.row(entity, id, 'summary-fields')) : undefined
    this.residents.apply({ type: 'update', rows: [{ kind: entity, id,
      value: row && row !== LOADING ? row : undefined } as RowSourceEvent['rows'][number]] })
    if (entity === 'session') {
      if (present) this.sessionQuestions().set(id, row && row !== LOADING ? row as Readonly<Record<string, unknown>> : undefined)
      else this.sessionQuestions().setFacts(id, this.index().sessionQuestionFact(id))
    }
    // Ranked windows do not have an identity answer to publish a delta through.
    for (const [key, state] of this.observed) {
      if (this.identities.has(key) || key.startsWith('count:')) continue
      const version = state.revision(this.index())
      if (state.version !== version) {
        state.version = version
        state.atom.reportChanged()
      }
    }
  }
  private sessionQuestions(): SessionQuestions {
    const index = this.index()
    if (!this.effectiveSessions || this.effectiveSource !== index) {
      this.effectiveSource = index
      this.effectiveSessions = index.forkSessionQuestions(
        id => this.index().sessionCollapsed(id), id => this.index().sessionOrderKey(id),
      )
    }
    return this.effectiveSessions
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
      question.kind === 'spawnIssues' ||
      (question.kind === 'commandIssueSessions' &&
        (question.archived !== undefined || question.includeShells !== undefined))
    )
  }
  private includes(question: ReaderQuestion, id: string): boolean {
    if (question.kind === 'residentIssues') return this.residentIssueIds.has(id)
    if (!this.sourceOnly(question) && this.pool.tables[questionEntity(question)].has(id))
      return this.residents.contains(question, id)
    return this.index().readerContains(question, id)
  }
  /** Addressed predicate membership; no identity answer is enumerated. */
  has(question: ReaderQuestion, id: string): boolean {
    return this.includes(question, id)
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
    const index = this.index()
    const fresh = this.sourceSeen !== undefined && this.sourceSeen !== index
    this.sourceSeen = index
    if (event.type === 'replace' || fresh) {
      this.effectiveSource = index
      this.effectiveSessions = index.forkSessionQuestions(
        id => this.index().sessionCollapsed(id), id => this.index().sessionOrderKey(id),
      )
      for (const id of residentIds(this.pool, 'session')) this.updateResident('session', id)
      for (const entity of ['issue', 'session'] as const) {
        this.extras[entity].clear()
        for (const id of residentIds(this.pool, entity)) this.correctCount(entity, id)
      }
    } else {
      const delta = index.changes(event)
      for (const [entity, id] of [...delta.flips, ...delta.orders])
        if (entity === 'session') this.sessionQuestions().visibilityChanged(id)
    }
    // Replacement counts were rebuilt from residents above. Observed identity
    // answers are rebuilt below from the new source catalog. Updating every
    // cold member here would construct an answer that is immediately discarded.
    for (const row of event.rows)
      if (row.kind === 'issue' || row.kind === 'session') {
        if (event.type !== 'replace' && !fresh) {
          this.correctCount(row.kind, row.id)
          this.updateIdentity(row.kind, row.id)
        }
        if (row.kind === 'session' && !this.pool.tables.session.has(row.id))
          this.sessionQuestions().setFacts(row.id, index.sessionQuestionFact(row.id))
      }
    for (const [key, state] of this.observed) {
      const version = state.revision(index)
      const result = this.identities.get(key)
      if (result && (event.type === 'replace' || result.source !== index)) {
        this.identities.set(key, this.identityResult(result.question, index))
        state.version = version
        state.atom.reportChanged()
      } else if (state.version !== version || fresh || event.type === 'replace') {
        state.version = version
        // Identity questions are notified only by a membership delta below.
        // Counts and ordered windows still follow their declared revisions.
        if (!result) state.atom.reportChanged()
      }
    }
    if (event.type === 'replace' || fresh) {
      for (const atom of this.sessionAtoms.values()) atom.reportChanged()
    } else {
      const delta = index.changes(event)
      for (const [entity, id] of delta.flips)
        if (entity === 'session') this.sessionAtoms.get(`collapsed:${id}`)?.reportChanged()
      for (const [entity, id] of delta.orders)
        if (entity === 'session') this.sessionAtoms.get(`order:${id}`)?.reportChanged()
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
    const index = this.watch(key, (value) => question.kind === 'headerRecentSession'
      ? this.sessionQuestions().recentRevision()
      : value.readerRevision(question) + (this.sourceOnly(question) ? 0 : this.residents.revision(question)))
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
    if (question.kind === 'residentIssues') return [...this.residentIssueIds]
    if (question.kind === 'headerRecentSession') {
      const excluded = question.excluded && 'has' in question.excluded ? question.excluded : new Set(question.excluded)
      const questions = this.sessionQuestions(), before = questions.visits
      const answer = questions.recent(excluded)
      this.counts.scalarVisits += questions.visits - before
      return answer ? [answer.id] : []
    }
    const ids = [...new Set([
      ...index.readerIds(question).filter(id =>
        !this.pool.tables[entity].has(id) || this.residents.contains(question, id)),
      ...this.residents.ids(question),
    ])]
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
  /** The effective source's indexed candidates, including pending overlays.
   * References, context paths and ranked windows must not add every resident
   * identity to an already bounded answer. */
  indexed(
    question: Extract<
      ReaderQuestion,
      { kind: 'sessionReference' | 'spawnIssues' | 'headerRecentSession' | 'containingIssues' }
    >,
  ): string[] {
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
    const index = this.watch(key, (value) =>
      repoPath === undefined
        ? value.issueRepoRevision + this.residents.repoRevision
        : value.issueRepoPathRevision(repoPath) + this.residents.repoPathRevision(repoPath),
    )
    return [...new Set([...index.issueRepoIds(repoPath), ...this.residents.repoIds(repoPath)])].sort()
  }
  activity(question: SessionActivityQuestion): number {
    const key = JSON.stringify({ ...question,
      ...(question.excluded ? { excluded: [...question.excluded] } : {}),
    })
    this.watch(`activity:${key}`, () => this.sessionQuestions().activityRevision(question))
    const questions = this.sessionQuestions(), before = questions.activityVisits
    const answer = questions.activity(question)
    this.counts.scalarVisits += questions.activityVisits - before
    return answer
  }
  collapsed(id: string): boolean {
    this.observeSession('collapsed', id)
    return this.index().sessionCollapsed(id)
  }
  /** One successor in attention order; absence starts at the first agent.
   * The source includes pending overlays; resident edits shadow changed keys. */
  nextTriageSession(id: string): string | undefined {
    const questions = this.sessionQuestions(), now = this.pool.clock.current, before = questions.visits
    const after = questions.triageFact(id, now)
    const answer = questions.next(after, now) ?? questions.next(undefined, now)
    this.counts.scalarVisits += questions.visits - before
    return answer?.id === id ? undefined : answer?.id
  }
  latestMachineSession(machineIds: readonly string[]): { machineId: string; createdAt: string } | undefined {
    this.watch(`latestMachine:${JSON.stringify(machineIds)}`, () => this.sessionQuestions().machineRevision(machineIds))
    const questions = this.sessionQuestions(), before = questions.visits
    const answer = questions.latest(machineIds)
    this.counts.scalarVisits += questions.visits - before
    return answer && { machineId: answer.machineId, createdAt: answer.createdAt }
  }
  orderKey(id: string): string {
    this.observeSession('order', id)
    return this.index().sessionOrderKey(id)
  }
  private observeSession(kind: 'collapsed' | 'order', id: string): void {
    const key = `${kind}:${id}`
    let atom = this.sessionAtoms.get(key)
    if (!atom) {
      const created = createAtom(`history.${key}`, undefined, () => this.sessionAtoms.delete(key))
      if (!created.reportObserved()) return
      this.sessionAtoms.set(key, created)
    } else atom.reportObserved()
  }
  dispose(): void {
    for (const stop of this.stopTables) stop()
    for (const result of [...this.results.values()]) result.dispose()
    this.results.clear()
    this.identities.clear()
    this.listeners.clear()
    this.memberListeners.clear()
    this.observed.clear()
    this.sessionAtoms.clear()
    this.residentIssueIds.clear()
    this.residents.apply({ type: 'replace', rows: [] })
    this.effectiveSessions?.clear()
    this.effectiveSessions = undefined
    this.effectiveSource = undefined
  }
}
