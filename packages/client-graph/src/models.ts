import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId, isFinished } from '@podium/model/browser'
import { groupRelations, type IssueCloseMemberCounts, type IssueCloseScalarSubject, type ReferentExit, type TaskProgress } from '@podium/client-core/values'
import type { ReaderQueries } from './reader-queries'
import { motionPhase as sessionMotion } from '@podium/client-core/values'

/** One shared object per server record. Schema fields and relations are installed
 * once; derived entity facts use @lazy. Views own their per-record companions. */

import { compareStructural } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import type { Residence } from './pool'
import type { SeatRelation } from './session-seats'
import type { CollectionName, IsLazy, SingleName, SubsetName, TargetOf } from './shared/links'
import type { RelationReader } from './shared/relation-reader'
import { FEED_SPELLING } from './shared/repo-from-lane'
import { type EntityName, SCHEMA, awaitingMergeOf } from './shared/schema'
import { computingDeadlineOf } from './shared/session-facts'
import type { SliceIssue, SliceSession, SliceWorktree } from './shared/slice-types'
import { type EditableStage, type EditPatch, EDITABLE_FIELDS, type TxId, type WritableKind } from './write/commands'
import type { StoredRow } from './tables'
import { activityMsOf, displayRefOf, parseMs, type RepoRow, repoTargetPartOf, prefixPartOf, originRefPartOf, type ViewInputs } from './views'
import { LOADING, type Loaded as LoadedRow, type OwnFacts, ownFactsOf, type RollupInputs, isSessionWorking } from './worklist/rollup'
import type { VisibleInputs } from './worklist/visible'

const EMPTY_DEPENDENTS: readonly { id: string; type: string }[] = Object.freeze([])

/** What a model reads from its pool. */
export interface ModelHost {
  /** The pool's one row reader (`MobxPool.row`): pending edits overlaid, `LOADING` when not in memory. */
  row(entity: EntityName, id: string, absent?: 'mark' | 'summary' | 'summary-fields'): LoadedRow<object>
  /** The pool's shared session object, including an addressed cold session. */
  sessionObject(id: string): SessionModel
  issueObject(id: string): IssueModel
  /** Addressed raw archived field, independent of payload/residency. */
  sessionArchiveField(id: string): boolean | undefined
  /** Whether the cutoff declares a stored session field, even when optional. */
  sessionSummaryField(property: string): boolean
  issueSummaryField(property: string): boolean
  issueExitKind(id: string): ReferentExit | undefined
  readonly queries: Pick<ReaderQueries, 'issueCloseCounts' | 'issueChildCounts'>
  /** Borrow the data layer's archive partition without copying its IDs. */
  sessionSeatIds(relation: SeatRelation, issueId: string, archived: boolean): readonly string[] | typeof LOADING
  /** The declared parent key, tracked without reading the source or target payload. */
  formalParent(id: string): string | null
  /** What the row view's parts read. */
  readonly inputs: ViewInputs
  /** What the visibility parts read. */
  readonly visibleInputs: VisibleInputs
  /** What the roll-up parts read (one per pool, shared by every issue). */
  readonly rollupInputs: RollupInputs
  /** One transaction of the write layer's edit log; throws when the pool has no write layer. */
  edit<K extends WritableKind>(entity: K, id: string, patch: EditPatch<K>): TxId
  /** The pool's relation reader: what the relation getters follow. */
  readonly relations: RelationReader
  /** The object of a row in memory, built on first request; undefined when not in memory. */
  model<E extends EntityName>(entity: E, id: string): ModelOf[E] | undefined
  /** Where a row stands; a cold one answers `loading` and is queued (first access). */
  resident(entity: EntityName, id: string): Residence
  /** Resident fallback seats; cold rows are requested from a declared lane summary. */
  rosterCandidates(path: string): Iterable<string>
}

function documentText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : ((value as { value?: string } | undefined)?.value ?? '')
}


export class EntityModel {
  /**
   * The schema fields this class answers with its own getter (`installFields`
   * keeps it and adds only the setter).
   */
  static readonly answers: ReadonlySet<string> = new Set<string>()

  constructor(
    readonly entity: EntityName,
    readonly id: string,
    protected readonly host: ModelHost,
  ) {}

  /** The row as the pool shows it (the one reader: tracked, pending edits overlaid). */
  get row(): StoredRow | undefined {
    const row = this.host.row(this.entity, this.id)
    return row === LOADING ? undefined : (row as StoredRow | undefined)
  }

  /** Schema-installed fields use the same reader, with no copied row. */
  storedField(property: string): unknown {
    return (this.row as Readonly<Record<string, unknown>> | undefined)?.[property]
  }
}

/**
 * The members every model instance carries itself (EntityModel's constructor
 * parameter properties). The prototype never carries an accessor of one of
 * these names: Babel's TypeScript transform (Metro: the phone build, web and
 * native) compiles a parameter property to an assignment, which a prototype
 * accessor intercepts (a getter-only one throws), where Vite and Bun define an
 * own property over it (POD-5370).
 */
const INSTANCE_MEMBERS: readonly string[] = Object.freeze(
  Object.keys(new EntityModel('issue', '', undefined as unknown as ModelHost)),
)

/**
 * Install one getter per declared field of `entity` on `prototype`, and a
 * setter per editable one. A field the class already answers is an error,
 * unless the class names it in `answers`: then the
 * class's getter stays and only the setter is added. A key field named like an
 * instance member (`id`) is the instance's own; any other such field collides.
 */
function installFields(
  prototype: EntityModel,
  entity: EntityName,
  answers: ReadonlySet<string>,
): void {
  const spec = SCHEMA[entity]
  const spelling = FEED_SPELLING[entity] ?? {}
  const editable: Readonly<Record<string, unknown>> =
    (EDITABLE_FIELDS as Readonly<Record<string, Readonly<Record<string, unknown>>>>)[entity] ?? {}
  for (const field of Object.keys(spec.fields)) {
    if (INSTANCE_MEMBERS.includes(field)) {
      if (field === spec.key && !Object.hasOwn(editable, field)) continue
      throw new Error(`[pool] ${entity}.${field} collides with a model member; rename one`)
    }
    const answered = answers.has(field)
      ? Object.getOwnPropertyDescriptor(prototype, field)?.get
      : undefined
    if (field in prototype && answered === undefined) {
      throw new Error(`[pool] ${entity}.${field} collides with a model member; rename one`)
    }
    const property = spelling[field] ?? field
    Object.defineProperty(prototype, field, {
      configurable: false,
      enumerable: false,
      get:
        answered ??
        function (this: EntityModel): unknown {
          if (field === spec.key) return this.id
          return this.storedField(property)
        },
      ...(Object.hasOwn(editable, field)
        ? {
            set(this: IssueModel, value: unknown): void {
              this.update({ [field]: value } as EditPatch<'issue'>)
            },
          }
        : {}),
    })
  }
}

/** Install one getter per declared relation of `entity` on `prototype` (POD-4758). */
function installRelations(prototype: EntityModel, entity: EntityName): void {
  for (const [name, spec] of Object.entries(SCHEMA[entity].relations)) {
    if (name in prototype) {
      throw new Error(`[pool] ${entity}.${name} collides with a model member; rename one`)
    }
    const collection =
      spec.kind === 'hasMany' || (spec.kind === 'edge' && (spec.direction === 'in' || spec.many))
    if (!collection) {
      Object.defineProperty(prototype, name, {
        configurable: false,
        enumerable: false,
        get(this: EntityModel): EntityModel | typeof LOADING | null {
          const host = hostOf(this)
          const target = host.relations.one(entity, this.id, name)
          return target === null ? null : objectOrLoading(host, spec.to, target)
        },
      })
      continue
    }
    // One collection class per relation, with a getter per declared subset.
    class Members extends ModelCollection {}
    for (const subset of spec.kind === 'hasMany' ? Object.keys(spec.subsets ?? {}) : []) {
      Object.defineProperty(Members.prototype, subset, {
        configurable: false,
        enumerable: false,
        get(this: Members): ModelCollection {
          return new ModelCollection(this.host, spec.to, this.owner, () =>
            this.host.relations.subset(entity, this.owner, name, subset),
          )
        },
      })
    }
    Object.defineProperty(prototype, name, {
      configurable: false,
      enumerable: false,
      get(this: EntityModel): ModelCollection {
        const host = hostOf(this)
        return new Members(host, spec.to, this.id, () => host.relations.many(entity, this.id, name))
      },
    })
  }
}

export function hostOf(model: EntityModel): ModelHost {
  return (model as unknown as { readonly host: ModelHost }).host
}

/** `to:id`'s object when its row is in memory, `LOADING` when cold (its load queued), else null. */
function objectOrLoading(
  host: ModelHost,
  to: EntityName,
  id: string,
): EntityModel | typeof LOADING | null {
  return host.model(to, id) ?? (host.resident(to, id) === 'loading' ? LOADING : null)
}

/**
 * A lazy collection read (Rule L): the members in memory, as objects, and
 * how many are still loading, every cold one queued. `ready` is in bucket
 * order, which is unordered (M3 F1). It is a READ, not a live view: the
 * first of `ready` or `loading` reads the members, once, where it is asked;
 * a reader that holds a collection across runs re-reads the getter.
 */
export interface LazyCollection<M> {
  readonly ready: readonly M[]
  readonly loading: number
}

class ModelCollection implements LazyCollection<EntityModel> {
  private read: { readonly ready: readonly EntityModel[]; readonly loading: number } | null = null

  constructor(
    readonly host: ModelHost,
    private readonly to: EntityName,
    /** The id of the row the collection belongs to (its subsets read under it). */
    readonly owner: string,
    private readonly members: () => Iterable<string>,
  ) {}

  get ready(): readonly EntityModel[] {
    return this.settle().ready
  }

  get loading(): number {
    return this.settle().loading
  }

  private settle(): { readonly ready: readonly EntityModel[]; readonly loading: number } {
    if (this.read !== null) return this.read
    const ready: EntityModel[] = []
    let loading = 0
    for (const id of this.members()) {
      const found = objectOrLoading(this.host, this.to, id)
      if (found === LOADING) loading += 1
      else if (found !== null) ready.push(found)
    }
    this.read = { ready, loading }
    return this.read
  }
}

type ObjectOne<E extends EntityName, R extends SingleName<E>> =
  IsLazy<E, R> extends false
    ? ModelOf[TargetOf<E, R>] | null
    : ModelOf[TargetOf<E, R>] | typeof LOADING | null

type ObjectMany<E extends EntityName, R extends CollectionName<E>> = LazyCollection<
  ModelOf[TargetOf<E, R>]
> & { readonly [S in SubsetName<E, R>]: LazyCollection<ModelOf[TargetOf<E, R>]> }

/**
 * The relation getters of `E`'s object, from the declared schema (POD-4758):
 * a single relation is the target's object, or null, or `LOADING` when the
 * relation is lazy; a collection is a `LazyCollection` with one per declared
 * subset.
 */
export type RelationGetters<E extends EntityName> = {
  readonly [R in SingleName<E>]: ObjectOne<E, R>
} & {
  readonly [R in CollectionName<E>]: ObjectMany<E, R>
}

/** The one shared issue record. Worklist presentation belongs to WorklistIssue. */
export class IssueModel extends EntityModel {
  static override readonly answers: ReadonlySet<string> = new Set(['description', 'notes'])
  constructor(id: string, host: ModelHost) {
    super('issue', id, host)
  }

  /** Edit this issue: one transaction of the write layer's log (paint, remember, send). */
  update(patch: EditPatch<'issue'>): TxId {
    return this.host.edit('issue', this.id, patch)
  }


  // Stored fields: display summaries never promote an undisplayed child.
  override storedField(property: string): unknown {
    if (property === 'readAt') return this.host.visibleInputs.issueRead(this.id)
    const resident = this.host.row('issue', this.id, 'mark')
    if (resident !== LOADING) return (resident as Record<string, unknown> | undefined)?.[property]
    if (this.host.issueSummaryField(property)) {
      const summary = this.host.row('issue', this.id, 'summary-fields')
      if (summary !== LOADING) return (summary as Record<string, unknown> | undefined)?.[property]
    }
    const row = this.host.row('issue', this.id)
    if (row === LOADING) throw LOADING
    return (row as Record<string, unknown> | undefined)?.[property]
  }

  @lazy get authoredTitle(): string {
    return String(this.storedField('title') ?? '')
  }
  @lazy get description(): string {
    return documentText(this.storedField('description'))
  }
  @lazy get notes(): string | undefined {
    const value = this.storedField('notes')
    return value === undefined ? undefined : documentText(value)
  }

  // Links: exit evidence is an addressed source read, never a neighbour map.
  @lazy get exitKind(): ReferentExit | undefined {
    return this.host.issueExitKind(this.id)
  }
  @lazy get relationGroups() {
    return groupRelations({
      deps: (this.storedField('deps') ?? []) as Parameters<typeof groupRelations>[0]['deps'],
      dependents: this.dependents as Parameters<typeof groupRelations>[0]['dependents'],
    })
  }

  // Readiness: only the defer deadline depends on the pool clock.
  @lazy get deferred(): boolean {
    const deadline = Date.parse(String(this.storedField('deferUntil') ?? ''))
    return Number.isFinite(deadline) && !this.host.inputs.reached(deadline)
  }
  @lazy get ready(): boolean {
    return (
      !this.storedField('blocked') &&
      !this.deferred &&
      !isFinished({
        stage: this.storedField('stage') as string,
        closedReason: this.storedField('closedReason') as string | null | undefined,
      })
    )
  }

  // Close: one question per field; counts borrow the maintained data layer.
  @lazy get closeNeedsHuman(): boolean {
    return Boolean(this.storedField('needsHuman'))
  }
  @lazy get closeQuestion(): string | undefined {
    return (this.storedField('asked') as { question?: string } | undefined)?.question
  }
  @lazy get closeGit(): IssueCloseScalarSubject['git'] {
    const git = this.storedField(
      'gitState',
    ) as import('@podium/client-core/values').IssueCloseSubject['gitState']
    return git
      ? {
          dirty: git.dirtyOwn ?? (!git.shared && !git.fallback ? git.dirtyFiles : 0),
          delivery: git.shared ? (git.commits?.length ?? 0) : (git.ahead ?? 0),
          shared: !!git.shared,
          merged: git.merged,
        }
      : undefined
  }
  get closeMembers(): IssueCloseMemberCounts {
    return this.host.queries.issueCloseCounts(this.id)
  }
  get closeChildren() {
    return this.host.queries.issueChildCounts(this.id)
  }
  /** Existing scalar consumers share the raw member fact, without another cache. */
  get sessionSummary() {
    return this.memberSummary
  }



  // Stored fields and presence
  /** Declared issue facts, usable without loading a historical payload. */
  @lazy private get factRow(): SliceIssue | undefined {
    const resident = this.host.row('issue', this.id, 'mark')
    if (resident !== LOADING) return resident as SliceIssue | undefined
    const summary = this.host.row('issue', this.id, 'summary-fields')
    return summary === LOADING ? undefined : summary as SliceIssue | undefined
  }

  @lazy get inMemory(): boolean { return this.host.resident('issue', this.id) === 'resident' }
  @lazy get finished(): boolean | undefined {
    const row = this.factRow
    return row === undefined ? undefined : isFinished(row)
  }
  @lazy get awaitingMerge(): boolean {
    const row = this.factRow
    return row !== undefined && awaitingMergeOf(row)
  }
  @lazy get updatedMs(): number | null { return parseMs(this.factRow?.updatedAt) }
  @lazy get finishedMs(): number { return parseMs(this.factRow?.closedAt ?? this.factRow?.updatedAt) ?? 0 }

  // Links and reference: independent of any screen's row label or nesting
  @lazy get displayRef(): string {
    return this.inMemory ? displayRefOf(this.seq, this.prefix) : ''
  }
  @lazy get repoTarget(): string | null { return repoTargetPartOf(this.host.inputs, this.id) }
  @lazy get prefix(): string | null { return prefixPartOf(this.host.inputs, this.repoTarget) }
  @lazy get originRef(): string | null { return originRefPartOf(this.host.inputs, this.id) }
  @lazy get parentRef(): string | null { return this.factRow?.parentId || null }
  get formalParent(): string | null { return this.host.formalParent(this.id) }

  private readOwnFacts(): OwnFacts { return ownFactsOf(this.host.rollupInputs.loadedIssue(this.id)) }

  // Presence: archive/deletion is independent of the sidebar's `placed` rule.
  @lazy
  get visible(): boolean {
    const row = this.host.row('issue', this.id)
    if (row === LOADING) throw LOADING
    return Boolean(row && !(row as SliceIssue).archived && !(row as SliceIssue).deletedAt)
  }

  @lazy
  get live(): boolean {
    let live = false, pending = false
    for (const id of this.host.relations.many('issue', this.id, 'missionSessions')) {
      try { live ||= this.host.sessionObject(id).open }
      catch (error) { if (error !== LOADING) throw error; pending = true }
    }
    if (!live && pending) throw LOADING
    return live
  }

  @lazy
  get hasLead(): boolean {
    const row = this.host.row('issue', this.id)
    if (row === LOADING) throw LOADING
    const id = (row as { coordinatorSessionId?: string } | undefined)?.coordinatorSessionId
    if (!id) return false
    for (const member of this.host.relations.many('issue', this.id, 'missionSessions')) {
      if (member === id) {
        const session = this.host.sessionObject(id)
        return session.onRoster && session.open
      }
    }
    return false
  }

  // Links: raw page membership includes headless, history and resume twins.
  get memberCount(): number { return this.host.relations.size('issue', this.id, 'pageSessions') }

  @lazy({ equals: compareStructural })
  get memberSessionIds(): ReturnType<typeof asSessionId>[] {
    return [...this.host.relations.many('issue', this.id, 'pageSessions')].sort().map(asSessionId)
  }

  // History: scalar session fields stop display-only changes at each member.
  @lazy({ equals: compareStructural })
  get memberSummary(): { total: number; byPhase: Record<string, number> } {
    const present = this.presentMemberPhases, archived = this.archivedMemberPhases
    if (present === LOADING || archived === LOADING) throw LOADING
    const phases = new Map(present)
    for (const [phase, value] of archived) {
      const previous = phases.get(phase)
      phases.set(phase, previous ? { count: previous.count + value.count,
        first: previous.first < value.first ? previous.first : value.first } : value)
    }
    const byPhase: Record<string, number> = {}
    let total = 0
    for (const [phase, value] of [...phases].sort((a, b) => a[1].first < b[1].first ? -1 : 1)) {
      byPhase[phase] = value.count
      total += value.count
    }
    return { total, byPhase }
  }

  @lazy
  get memberLatestActivity(): number {
    const present = this.presentMemberActivity, archived = this.archivedMemberActivity
    if (present === LOADING || archived === LOADING) throw LOADING
    return Math.max(present, archived)
  }

  // Archive contributions stay observed independently: a live heartbeat or
  // phase change never walks the issue's unchanged historical members.
  @lazy private get presentMemberPhases() { return this.readMemberPhases(false) }
  @lazy private get archivedMemberPhases() { return this.readMemberPhases(true) }
  @lazy private get presentMemberActivity() { return this.readMemberActivity(false) }
  @lazy private get archivedMemberActivity() { return this.readMemberActivity(true) }

  private readMemberPhases(archived: boolean): ReadonlyMap<string, { count: number; first: string }> | typeof LOADING {
    const ids = this.host.sessionSeatIds('pageSessions', this.id, archived)
    if (ids === LOADING) return LOADING
    const phases = new Map<string, { count: number; first: string }>()
    let pending = false
    for (const id of ids) {
      const session = this.host.sessionObject(id)
      try {
        if (!session.exists) continue
        const phase = session.phase
        const previous = phases.get(phase)
        phases.set(phase, previous ? { count: previous.count + 1,
          first: previous.first < id ? previous.first : id } : { count: 1, first: id })
      } catch (error) { if (error !== LOADING) throw error; pending = true }
    }
    return pending ? LOADING : phases
  }

  private readMemberActivity(archived: boolean): number | typeof LOADING {
    const ids = this.host.sessionSeatIds('pageSessions', this.id, archived)
    if (ids === LOADING) return LOADING
    let latest = -Infinity, pending = false
    for (const id of ids) {
      try {
        const at = this.host.sessionObject(id).activityMs
        if (at !== null && at > latest) latest = at
      } catch (error) { if (error !== LOADING) throw error; pending = true }
    }
    return pending ? LOADING : latest
  }

  // Task progress: formal descendants, independent of sidebar/mission placement.
  get childCount(): number { return this.host.relations.size('issue', this.id, 'treeChildren') }

  get childDoneCount(): number { return this.childCount ? this.finishedChildren : 0 }

  @lazy
  private get finishedChildren(): number {
    let done = 0
    for (const id of this.host.relations.many('issue', this.id, 'treeChildren')) {
      const row = this.host.row('issue', id, 'summary-fields') as LoadedRow<SliceIssue>
      if (row === LOADING) throw LOADING
      if (row && isFinished(row)) done++
    }
    return done
  }

  get confirmedWorkingAgents(): number {
    const ids = this.host.sessionSeatIds('pageSessions', this.id, false)
    if (ids === LOADING) throw LOADING
    return ids.length ? this.confirmedWorkerCount : 0
  }

  @lazy
  private get confirmedWorkerCount(): number {
    const ids = this.host.sessionSeatIds('pageSessions', this.id, false)
    if (ids === LOADING) throw LOADING
    let count = 0
    for (const id of ids) if (this.host.sessionObject(id).confirmedWorking) count++
    return count
  }

  get taskProgress(): TaskProgress | null { return this.childCount ? this.descendantTaskProgress : null }

  @lazy({ equals: compareStructural })
  private get descendantTaskProgress(): TaskProgress | null {
    let total = 0, done = 0, liveAgents = 0
    const seen = new Set([this.id]), stack = [...this.host.relations.many('issue', this.id, 'treeChildren')]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const row = this.host.row('issue', id, 'summary') as LoadedRow<SliceIssue>
      if (row === LOADING) throw LOADING
      if (!row || row.archived || row.deletedAt || row.isDraftVessel) continue
      total++
      if (isFinished(row)) done++
      liveAgents += this.host.issueObject(id).confirmedWorkingAgents
      stack.push(...this.host.relations.many('issue', id, 'treeChildren'))
    }
    return total ? { total, done, liveAgents } : null
  }

  // Links: all reverse dependency edges, including their declared type.
  get dependents(): readonly { id: string; type: string }[] {
    return this.host.relations.size('issue', this.id, 'pageDependents') ? this.dependencySources : EMPTY_DEPENDENTS
  }

  @lazy({ equals: compareStructural })
  private get dependencySources(): readonly { id: string; type: string }[] {
    const result: { id: string; type: string }[] = []
    for (const id of [...this.host.relations.many('issue', this.id, 'pageDependents')].sort()) {
      const row = this.host.row('issue', id, 'summary') as LoadedRow<SliceIssue>
      if (row === LOADING) throw LOADING
      for (const dep of row?.deps ?? []) if (dep.id === this.id) result.push({ id, type: dep.type })
    }
    return result
  }

  // ------------------------------------------------------ resident decision facts

  get ownFacts(): Omit<OwnFacts, 'order'> {
    const model = this
    return {
      get state() { return model.ownState },
      get finished() { return model.ownFactFinished },
      get decision() { return model.ownFactDecision },
      get continuedByField() { return model.ownFactContinuedByField },
      get updatedAt() { return model.ownFactUpdatedAt },
      get closedAt() { return model.ownFactClosedAt },
      get coordinatorSessionId() { return model.ownFactCoordinatorSessionId },
    }
  }

  @lazy
  private get ownState(): OwnFacts['state'] {
    const state = this.host.resident('issue', this.id)
    return state === 'resident' ? 'ready' : state === 'loading' ? 'cold' : 'unknown'
  }

  @lazy
  private get ownFactFinished(): OwnFacts['finished'] {
    return this.ownState === 'ready' && (this.finished ?? false)
  }

  @lazy
  private get ownFactDecision(): OwnFacts['decision'] {
    return this.readOwnFacts().decision
  }

  @lazy
  private get ownFactContinuedByField(): OwnFacts['continuedByField'] {
    return this.readOwnFacts().continuedByField
  }

  @lazy
  private get ownFactUpdatedAt(): OwnFacts['updatedAt'] {
    const row = this.host.rollupInputs.loadedIssue(this.id)
    return row === LOADING || row === undefined ? undefined : row.updatedAt
  }

  @lazy
  private get ownFactClosedAt(): OwnFacts['closedAt'] {
    const row = this.host.rollupInputs.loadedIssue(this.id)
    return row === LOADING || row === undefined ? undefined : row.closedAt
  }

  @lazy
  private get ownFactCoordinatorSessionId(): OwnFacts['coordinatorSessionId'] {
    const row = this.host.rollupInputs.loadedIssue(this.id)
    return row === LOADING || row === undefined ? undefined : row.coordinatorSessionId
  }

}

/** THE session: its row, and what its issues read of it. */
export class SessionModel extends EntityModel {
  static override readonly answers = new Set(['archived'])

  constructor(id: string, host: ModelHost) {
    super('session', id, host)
  }

  // Stored fields: declared summaries can answer a field without promoting it.
  @lazy private get residentRow(): StoredRow | typeof LOADING | undefined {
    return this.host.row('session', this.id, 'mark') as StoredRow | typeof LOADING | undefined
  }

  @lazy
  private get declaredRow(): StoredRow | typeof LOADING | undefined {
    return this.residentRow === LOADING
      ? this.host.row('session', this.id, 'summary-fields') as StoredRow | typeof LOADING | undefined
      : this.residentRow
  }

  /** A resident record or its declared summary, without requesting its payload. */
  @lazy get known(): boolean { return this.declaredRow !== undefined && this.declaredRow !== LOADING }

  override storedField(property: string): unknown {
    if (this.residentRow !== LOADING) return (this.residentRow as Readonly<Record<string, unknown>> | undefined)?.[property]
    const summary = this.declaredRow
    if (summary !== LOADING && this.host.sessionSummaryField(property)) {
      return (summary as Readonly<Record<string, unknown>> | undefined)?.[property]
    }
    const row = this.host.row('session', this.id)
    if (row === LOADING) throw LOADING
    return (row as Record<string, unknown> | undefined)?.[property]
  }

  @lazy
  get exists(): boolean {
    const resident = this.host.row('session', this.id, 'mark')
    if (resident !== LOADING) return resident !== undefined
    const summary = this.host.row('session', this.id, 'summary')
    // A complete declared display summary is a usable session object; a
    // partial cutoff still spends the shared batched load window.
    if (summary && summary !== LOADING && ['sessionId', 'cwd', 'status', 'lastActiveAt', 'title'].every(field => Object.hasOwn(summary, field))) return true
    const row = this.host.row('session', this.id)
    if (row === LOADING) throw LOADING
    return row !== undefined
  }

  // Presence: open means present on the task, including a hibernated session.
  @lazy
  get archived(): boolean | undefined {
    const flag = this.host.sessionArchiveField(this.id)
    if (flag !== undefined) return flag
    const row = this.host.row('session', this.id, 'mark')
    if (row === undefined) return undefined
    return Boolean(this.storedField('archived'))
  }

  @lazy
  get open(): boolean { return !this.archived && this.exists && this.status !== 'exited' }

  @lazy
  get onRoster(): boolean { return !this.archived && this.rosterEligible }

  @lazy
  get rosterEligible(): boolean { return this.exists && !this.headless && this.agentKind !== 'shell' }

  // Unlike verdict.working, atWork includes starting/reconnecting before motion.
  @lazy
  get atWork(): boolean {
    return this.open && (this.status === 'starting' || this.status === 'reconnecting' || this.workingMotion)
  }

  @lazy
  // Motion lets an offer/question override execution; verdict.working reports execution alone.
  get motion(): ReturnType<typeof sessionMotion> { return this.exists ? sessionMotion(this as SessionView) : 'queued' }

  @lazy
  get workingMotion(): boolean { return this.motion === 'working' }

  @lazy
  get settled(): boolean { return !this.open || this.motion === 'done' }

  @lazy
  // Execution can read a declared cold summary; the sidebar verdict still waits for residency.
  get executing(): boolean { return this.exists && isSessionWorking(this as unknown as SliceSession) }

  @lazy
  get stateSinceMs(): number { return Date.parse(this.agentState?.since ?? this.lastActivity) }

  @lazy
  get executionSinceMs(): number | null {
    return this.executing && Number.isFinite(this.stateSinceMs) ? this.stateSinceMs : null
  }

  @lazy
  get asking(): boolean {
    return !this.archived && this.exists && (this.phase === 'needs_user' || this.phase === 'errored' || Boolean(this.offer))
  }

  /** Fresh execution evidence is a session fact; views decide which agents to show. */
  @lazy
  get computingDeadline(): number | undefined {
    const row = this.declaredRow
    return computingDeadlineOf(row === LOADING ? undefined : row as SessionView | undefined)
  }

  @lazy
  get computingFresh(): boolean {
    return this.computingDeadline !== undefined && !this.host.inputs.passed(this.computingDeadline)
  }

  /** Formal task progress counts confirmed non-shell, non-headless agents. */
  @lazy
  get confirmedWorking(): boolean {
    return !this.headless && this.agentKind !== 'shell' && this.computingFresh
  }

  // History: one scalar per question, shared by navigation and every mission.
  @lazy
  get phase(): string { return this.exists ? this.agentState?.phase ?? 'unknown' : 'unknown' }

  @lazy
  get moved(): boolean { return Boolean(this.handoffTarget) }

  @lazy
  get lastActivity(): string { return this.lastActiveAt ?? '' }

  @lazy
  get lastInput(): string | undefined { return this.lastInputAt }

  @lazy
  get transcript(): boolean | undefined { return this.transcriptAvailable }

  @lazy
  get historyKind(): SessionView['agentKind'] { return this.agentKind }

  // Display joins: these are resolved from linked rows, not stored SessionMeta fields.
  @lazy
  get machineName(): SessionView['machineName'] { return this.storedField('machineName') as SessionView['machineName'] }

  @lazy
  get condition(): SessionView['condition'] { return this.storedField('condition') as SessionView['condition'] }

  // Activity: the same timestamp answers activityMs and raw member history.
  @lazy
  get activityMs(): number | null {
    return activityMsOf({ lastActiveAt: this.lastActivity } as SliceSession)
  }

  // Links
  @lazy
  get issueLink(): string | null {
    return this.host.visibleInputs.links.session.issue(this.id)
  }

  @lazy
  get worktreeLink(): string | null {
    return this.host.visibleInputs.links.session.worktree(this.id)
  }


}

export class WorktreeModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('worktree', id, host)
  }


}

class RepoModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('repo', id, host)
  }

  /** One addressed facade for every join. Its fields still track independently. */
  @lazy override get row(): StoredRow | undefined {
    return super.row
  }
}

/**
 * The issue's editable fields as setters take them (`issue.stage = 'review'`).
 * `title` reads and edits the stored title; a worklist row derives its own label.
 */
interface IssueEdits {
  get title(): string
  set title(value: string)
  get stage(): string
  set stage(value: EditableStage)
  get readAt(): string | null | undefined
  set readAt(value: string)
}

/**
 * A model with its schema getters, typed. The getters are installed from the
 * schema at runtime (`installFields`); their TYPES come from the slice types
 * the feed rows already carry, so no field list is written here.
 */
// Schema-installed session fields are typed by their wire contract. Derived
// presence fields above keep their scalar types, and no row is stored here.
export interface SessionModel extends Readonly<Omit<SessionView, 'archived' | 'condition'>>, RelationGetters<'session'> {}

export interface IssueModel extends Readonly<Omit<SliceIssue, 'title' | 'stage' | 'readAt' | 'description' | 'notes'>>, IssueEdits, RelationGetters<'issue'> {}

export type ModelOf = {
  issue: IssueModel &
    Readonly<Omit<SliceIssue, 'title' | 'stage' | 'readAt' | 'description' | 'notes'>> &
    IssueEdits &
    RelationGetters<'issue'>
  session: SessionModel
  worktree: WorktreeModel &
    Readonly<Pick<SliceWorktree, 'path' | 'repoId' | 'repoPath'>> &
    RelationGetters<'worktree'>
  repo: RepoModel & Readonly<RepoRow> & { readonly path?: string } & RelationGetters<'repo'>
}

/** The model class of each schema entity. */
export const MODEL_CLASSES: {
  readonly [E in EntityName]: (new (
    id: string,
    host: ModelHost,
  ) => EntityModel) &
    Pick<typeof EntityModel, 'answers'>
} = {
  issue: IssueModel,
  session: SessionModel,
  worktree: WorktreeModel,
  repo: RepoModel,
}

for (const entity of Object.keys(MODEL_CLASSES) as EntityName[]) {
  installFields(MODEL_CLASSES[entity].prototype, entity, MODEL_CLASSES[entity].answers)
  installRelations(MODEL_CLASSES[entity].prototype, entity)
}
