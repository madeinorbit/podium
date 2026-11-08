import { type IssueNavigationModel, issuePendingDecision, missionTaskBucket, type MissionTaskBucket } from '@podium/client-core/values'
import type { LiveStore } from '@podium/client-core/live'
import type { EffectError, EffectRecordWire, EffectStatus, IssueGitState, IssuePanel, IssuePanelArtifact, IssueProjection } from '@podium/model'
import { here, isGone, type Lookup, omitGone } from './lookup'
import type { MessageModel, PendingInteractionModel } from './message-models'
import { ReadObservation } from './read-observation'
import type { AccountModel, DeviceModel, MemberModel, PodiumSettingsModel, RepositoryModel } from './requested-models'
import type { AutomationModel, AutomationRunModel, MachineModel } from './synced-models'

export type { AutomationModel, AutomationRunModel, MachineModel } from './synced-models'

import { attentionGroup, effectiveRecency } from '@podium/client-core/focus'
import type { SessionView } from '@podium/client-core/session-values'
import { groupRelations, type IssueCloseMemberCounts, type IssueCloseScalarSubject, type ReferentExit, motionPhase as sessionMotion, type TaskProgress } from '@podium/client-core/values'
import { isTurnOpen, readEffectStatus, SESSION_INTERRUPT_KIND } from '@podium/model/browser'
import {
  ISSUE_ADD_SESSION_KIND,
  ISSUE_BEGIN_KIND,
  ISSUE_START_KIND,
  ISSUE_WORK_KINDS,
  SESSION_CONFIGURE_KIND,
  SESSION_HANDOFF_KIND,
  SESSION_LAUNCH_KIND,
} from '@podium/client-core/spawn-agent'
import { asSessionId, type CoordinatedSeat, coordinatedSeat, sessionWorkingFact, inPersonalSet, isExcluded, isFinished, NO_INTERACTIONS, type SeatInteractions, type SeatRole, type SeatSessionFacts, type SessionWord, type SessionWordFacts, sessionWord, wordWantsAttention } from '@podium/model/browser'
import type { ReaderQueries } from './reader-queries'
import type { IssueSessionFactReader } from './shared/issue-session-facts'

/** One shared object per server record. Schema fields and relations are installed
 * once; derived entity facts use @lazy. Views own their per-record companions. */

import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow, compareStructural, observable, runInAction } from 'mobx'
import type { Residence } from './pool'
import type { SeatRelation } from './session-seats'
import type { CollectionName, IsLazy, SingleName, SubsetName, TargetOf } from './shared/links'
import type { RelationReader } from './shared/relation-reader'
import { FEED_SPELLING } from './shared/repo-from-lane'
import { awaitingMergeOf, type EntityName, type ModelSchema, SCHEMA } from './shared/schema'
import { computingDeadlineOf } from './shared/session-facts'
import type { SliceIssue, SliceSession, SliceWorktree } from './shared/slice-types'
import type { StoredRow } from './tables'
import { activityMsOf, DEFER_NEXT_MESSAGE, displayRefOf, originRefPartOf, parseMs, prefixPartOf, type RepoRow, repoTargetPartOf, type ViewInputs } from './views'
import { isSessionWorking, LOADING, type Loaded as LoadedRow, type OwnFacts, ownFactsOf, type RollupInputs } from './worklist/rollup'
import { fleetOf, type SidebarSessionFacts, unstarted } from './worklist/sidebar-row'
import type { VisibleInputs } from './worklist/visible'
import { EDITABLE_FIELDS, type EditableStage, type EditPatch, type TxId, type WritableKind } from './write/commands'

const EMPTY_DEPENDENTS: readonly { id: string; type: string }[] = Object.freeze([])

// Direct work-row paint readers need scalar equality when an unrelated stored
// field changes. Other installed stored getters stay plain.
const ISSUE_PAINT_FIELDS: ReadonlySet<string> = new Set([
  'title', 'audience', 'pinned', 'linearIdentifier', 'seq', 'acceptance',
  'stage', 'closedReason', 'blocked', 'branch', 'gitState', 'parentBranch',
  'landedAt', 'landedSha',
  'updatedAt', 'closedAt', 'tuckedAt',
])

/** What a model reads from its pool. */
/** Borrow the session document's existing sync/arbitration owner; never copy its text. */
export interface SessionDrafts {
  get(sessionId: import('@podium/model').SessionId): string
  set(sessionId: import('@podium/model').SessionId, text: string): void
}
export interface ModelHost {
  readonly sessionDrafts?: SessionDrafts
  /** This user's conditions (POD-5798): machine online, since and load. */
  readonly live?: LiveStore

  readonly issueSessionFact: IssueSessionFactReader
  /** The pool's one row reader (`MobxPool.row`): pending edits overlaid, `LOADING` when not in memory. */
  row(entity: EntityName, id: string, absent?: 'mark' | 'summary' | 'summary-fields'): Lookup<object>
  /** The pool's shared session object, including an addressed cold session. */
  sessionObject(id: string): SessionModel
  issueObject(id: string): IssueModel
  /** Addressed raw archived field, independent of payload/residency. */
  sessionArchiveField(id: string): boolean | undefined
  /** Open pending interactions addressed to a session (`MobxPool.sessionOpenInteractions`). */
  sessionOpenInteractions(id: string): SeatInteractions
  /** Whether the cutoff declares a stored session field, even when optional. */
  sessionSummaryField(property: string): boolean
  issueSummaryField(property: string): boolean
  issueExitKind(id: string): ReferentExit | undefined
  readonly queries: Pick<ReaderQueries, 'issueCloseCounts' | 'issueChildCounts' | 'collapsed' | 'orderKey'>
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
  /** The addressed model: here, loading, or gone. */
  model<E extends EntityName>(entity: E, id: string): Lookup<ModelOf[E]>
  /** Where a row stands; a cold one answers `loading` and is queued (first access). */
  resident(entity: EntityName, id: string, absent?: 'load' | 'summary-fields'): Residence
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
  get row(): Lookup<Readonly<Record<string, unknown>>> {
    return this.host.row(this.entity, this.id) as Lookup<Readonly<Record<string, unknown>>>
  }

  /** Schema-installed fields use the same reader, with no copied row. */
  storedField(property: string): unknown {
    const row = this.row
    if (row === LOADING) throw LOADING
    if (isGone(row)) return undefined
    return (row as Readonly<Record<string, unknown>>)[property]
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
    const stored = function (this: EntityModel): unknown {
      if (field === spec.key) return this.id
      return this.storedField(property)
    }
    // Immutable identity keys need no computed boundary or observable dependency.
    // Only direct paint readers need another scalar equality boundary.
    const get = answered ?? (field !== spec.key && (entity === 'session' || entity === 'issue' && ISSUE_PAINT_FIELDS.has(field)) ? (entity === 'session' && spec.fields[field]?.type === 'object' ? lazy({ equals: compareStructural }) : lazy)(stored, {
      kind: 'getter', name: field, static: false, private: false,
      access: { has: target => field in target, get: target => stored.call(target) },
      addInitializer() {}, metadata: {},
    }) : stored)
    Object.defineProperty(prototype, field, {
      configurable: false,
      enumerable: false,
      get,
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
    const members = (host: ModelHost, owner: string) => host.relations.many(entity, owner, name)
    for (const subset of spec.kind === 'hasMany' ? Object.keys(spec.subsets ?? {}) : []) {
      const subsetMembers = (host: ModelHost, owner: string) => host.relations.subset(entity, owner, name, subset)
      Object.defineProperty(Members.prototype, subset, {
        configurable: false,
        enumerable: false,
        get: collectionGetter(subset, function (this: Members): ModelCollection {
          subsetMembers(this.host, this.owner)
          return new ModelCollection(this.host, spec.to, this.owner, subsetMembers)
        }),
      })
    }
    Object.defineProperty(prototype, name, {
      configurable: false,
      enumerable: false,
      get: collectionGetter(name, function (this: EntityModel): ModelCollection {
        const host = hostOf(this)
        members(host, this.id)
        return new Members(host, spec.to, this.id, members)
      }),
    })
  }
}

/** Schema-installed collection handles use the same lifetime as @lazy
 * class fields. The handle reads live lists, rather than storing its first answer. */
function collectionGetter<T extends object, V>(name: string, get: (this: T) => V): (this: T) => V {
  return lazy<V>({ equals: compareShallow })(get, {
    kind: 'getter', name, static: false, private: false,
    access: { has: target => name in target, get: target => get.call(target) },
    addInitializer() {}, metadata: {},
  })
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
  const answer = host.model(to, id)
  return isGone(answer) ? null : answer
}

/** A live collection (Rule L). `ready` is the shallow-equal list of shared
 * models in bucket order (unordered, M3 F1); `loading` counts cold members and
 * queues their loads. Retaining the handle never retains a stale answer. */
export interface LazyCollection<M> {
  readonly ready: readonly M[]
  readonly loading: number
}

class ModelCollection implements LazyCollection<EntityModel> {
  constructor(
    readonly host: ModelHost,
    private readonly to: EntityName,
    /** The id of the row the collection belongs to (its subsets read under it). */
    readonly owner: string,
    private readonly members: (host: ModelHost, owner: string) => Iterable<string>,
  ) {}

  @lazy({ equals: compareShallow })
  get ready(): readonly EntityModel[] {
    const ready: EntityModel[] = []
    for (const id of this.members(this.host, this.owner)) {
      const found = objectOrLoading(this.host, this.to, id)
      if (found !== LOADING && found !== null) ready.push(found)
    }
    return ready
  }

  @lazy
  get loading(): number {
    let loading = 0
    for (const id of this.members(this.host, this.owner)) {
      if (objectOrLoading(this.host, this.to, id) === LOADING) loading += 1
    }
    return loading
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
  readonly readObservation = new ReadObservation()
  static override readonly answers: ReadonlySet<string> = new Set(['description'])
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
    const resident = omitGone(this.host.row('issue', this.id, 'mark'))
    if (resident !== LOADING) return (resident as Record<string, unknown> | undefined)?.[property]
    if (this.host.issueSummaryField(property)) {
      const summary = omitGone(this.host.row('issue', this.id, 'summary-fields'))
      if (summary !== LOADING) return (summary as Record<string, unknown> | undefined)?.[property]
    }
    const row = omitGone(this.host.row('issue', this.id))
    if (row === LOADING) throw LOADING
    return (row as Record<string, unknown> | undefined)?.[property]
  }

  @lazy get authoredTitle(): string {
    return String(this.storedField('title') ?? '')
  }

  // The viewer's personal set (POD-6290; design §2.2): the tasks they started
  // or joined, plus the ones carrying their "assigned to you by X" row. What
  // they can see, search or open is not in it. One rule, the model package's.
  @lazy get inPersonalSet(): boolean {
    return inPersonalSet({
      joinedAt: this.storedField('joinedAt') as string | null | undefined,
      assignedAt: this.storedField('assignedAt') as string | null | undefined,
    })
  }

  // Chat uploads (POD-2148): the stored copy of each file attached in one of
  // this issue's chats, by the attachment id it was staged under. The chat
  // shows a thumbnail from it once the daemon's upload sweep deleted the file.
  @lazy get chatUploads(): ReadonlyMap<string, IssuePanelArtifact> {
    const panel = this.storedField('panel') as IssuePanel | undefined
    const out = new Map<string, IssuePanelArtifact>()
    for (const artifact of panel?.artifacts ?? [])
      if (artifact.chatUploadId && artifact.artifactId) out.set(artifact.chatUploadId, artifact)
    return out
  }
  @lazy get description(): string {
    return documentText(this.storedField('description'))
  }

  // The issue's own work (POD-6526): start, stop, cleanup, ship and the
  // assistant are effect records targeting it, read here on every device.
  /** The issue action asked for most recently, as its effect record. */
  @lazy get workAction(): EffectModel | undefined {
    let latest: EffectModel | undefined
    for (const effect of this.effects.ready) {
      if (!ISSUE_WORK_KINDS.has(effect.kind)) continue
      if (latest === undefined || effect.createdAt > latest.createdAt) latest = effect
    }
    return latest
  }
  /** The kind of the issue action still on its way (`issue.stop`, …), if any. */
  @lazy get workPending(): string | undefined {
    const action = this.workAction
    return action?.inFlight === true ? action.kind : undefined
  }

  // Activity and headless presence: raw ownership maxima/counters include
  // cold history and never replace the stored issue record.
  @lazy get lastActivityAt(): string | undefined { return this.host.issueSessionFact(this.id, 'replicaActivityAt') }
  @lazy get tipActivityAt(): string | undefined { return this.host.issueSessionFact(this.id, 'tipActivityAt') }
  @lazy get headlessStaffed(): boolean { return this.host.issueSessionFact(this.id, 'headlessStaffed') }
  @lazy get headlessOccupied(): boolean { return this.host.issueSessionFact(this.id, 'headlessOccupied') }

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
    const until = this.storedField('deferUntil')
    if (until === DEFER_NEXT_MESSAGE) return true
    const deadline = Date.parse(String(until ?? ''))
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
  private readFacts(): SliceIssue | undefined {
    const resident = omitGone(this.host.row('issue', this.id, 'mark'))
    if (resident !== LOADING) return resident as SliceIssue | undefined
    const summary = omitGone(this.host.row('issue', this.id, 'summary-fields'))
    return summary === LOADING ? undefined : summary as SliceIssue | undefined
  }

  @lazy get excluded(): boolean {
    const row = this.readFacts()
    return row !== undefined && isExcluded(row)
  }

  @lazy get inMemory(): boolean { return this.host.resident('issue', this.id) === 'resident' }
  /** Availability of the declared summary, without promoting a historical payload. */
  @lazy get summaryResidence(): Residence { return this.host.resident('issue', this.id, 'summary-fields') }
  @lazy get finished(): boolean | undefined {
    const row = this.readFacts()
    return row === undefined ? undefined : isFinished(row)
  }
  @lazy get awaitingMerge(): boolean {
    const row = this.readFacts()
    return row !== undefined && awaitingMergeOf(row)
  }
  @lazy get pendingDecision(): 'merge' | 'review' | null {
    const row = this.readFacts()
    return row ? issuePendingDecision(row as unknown as IssueNavigationModel) : null
  }
  @lazy get updatedMs(): number | null { return parseMs(this.readFacts()?.updatedAt) }
  @lazy get finishedMs(): number {
    const row = this.readFacts()
    return parseMs(row?.closedAt ?? row?.updatedAt) ?? 0
  }

  // Links and reference: independent of any screen's row label or nesting
  /** The declared `seq` answers a cold row too, without loading its payload. */
  @lazy get displayRef(): string {
    const seq = this.readFacts()?.seq
    return seq === undefined ? '' : displayRefOf(seq, this.prefix)
  }
  @lazy get repoTarget(): string | null { return repoTargetPartOf(this.host.inputs, this.id) }
  @lazy get prefix(): string | null { return prefixPartOf(this.host.inputs, this.repoTarget) }
  @lazy get originRef(): string | null { return originRefPartOf(this.host.inputs, this.id) }
  @lazy get parentRef(): string | null { return this.readFacts()?.parentId || null }
  get formalParent(): string | null { return this.host.formalParent(this.id) }
  /** The parent is archived or deleted, read from its declared summary (`CloseFacts.parentGone`). */
  @lazy get parentGone(): boolean {
    const parentId = this.parentRef
    if (parentId === null) return false
    const parent = omitGone(this.host.row('issue', parentId, 'summary-fields'))
    if (parent === LOADING || parent === undefined) return false
    const { archived, deletedAt } = parent as Pick<SliceIssue, 'archived' | 'deletedAt'>
    return archived === true || deletedAt != null
  }

  private readOwnFacts(): OwnFacts { return ownFactsOf(this.host.rollupInputs.loadedIssue(this.id)) }

  // Presence: archive/deletion is independent of the sidebar's `placed` rule.
  @lazy
  get visible(): boolean {
    const row = omitGone(this.host.row('issue', this.id))
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
    const row = omitGone(this.host.row('issue', this.id))
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

  // Launch history: a stage, checkout, or present agent proves work has begun.
  @lazy
  get workBegun(): boolean {
    if (this.worktreePath || this.stage === 'planning' || this.stage === 'in_progress' ||
      this.stage === 'review' || this.stage === 'shipping') return true
    const ids = this.host.sessionSeatIds('pageSessions', this.id, false)
    if (ids === LOADING) throw LOADING
    let pending = false
    for (const id of ids) {
      try { if (this.host.sessionObject(id).open) return true }
      catch (error) { if (error !== LOADING) throw error; pending = true }
    }
    if (pending) throw LOADING
    return false
  }

  // Session target: where "go to session" lands for this task.
  /** This task's own visible live seat, in the dock roster's contract order:
   * the coordinator when it is one of them, else the most recently active
   * (ties keep the collapse order). Headless seats cannot be opened; a seat
   * still loading is skipped until it lands. Undefined without a visible seat. */
  @lazy
  get liveSeatId(): string | undefined {
    const coordinator = this.storedField('coordinatorSessionId')
    let best: { id: string; at: string } | null = null
    for (const id of this.host.relations.subset('issue', this.id, 'pageSessions', 'unarchived')) {
      if (this.host.queries.collapsed(id)) continue
      const session = this.host.sessionObject(id)
      let at: string
      try {
        if (session.headless || session.status === 'exited') continue
        if (id === coordinator) return id
        at = session.lastActiveAt ?? ''
      } catch (error) { if (error !== LOADING) throw error; continue }
      const order = best ? at.localeCompare(best.at) : 1
      if (order > 0 || (order === 0 && best &&
        this.host.queries.orderKey(id).localeCompare(this.host.queries.orderKey(best.id)) < 0))
        best = { id, at }
    }
    return best?.id
  }

  /** The nearest task up the raw parent chain, this one first, whose live seat
   * covers it: a subtask is usually worked in its parent's session. The walk
   * stops at an ancestor that is not loaded, and on a cyclic chain. */
  @lazy
  get seatHolderId(): string | null {
    const seen = new Set<string>()
    for (let id: string | null = this.id; id && !seen.has(id); id = this.host.relations.one('issue', id, 'treeParent')) {
      seen.add(id)
      if (this.host.resident('issue', id) !== 'resident') return null
      if (this.host.issueObject(id).liveSeatId) return id
    }
    return null
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

  /** Present non-shell members, by session id: unarchived, known from a
   * resident row or declared summary (no payload load), and not folded into a
   * resumed twin. A heartbeat never re-sorts this list. */
  @lazy({ equals: compareShallow })
  get presentMembers(): readonly SessionModel[] {
    const present: SessionModel[] = []
    for (const id of [...this.livePageSessionIds()].sort()) {
      const session = this.host.sessionObject(id)
      if (session.known && !this.host.queries.collapsed(id)) present.push(session)
    }
    return present
  }

  // Read state: the replica rollup. Updated, or a non-shell member (archived
  // included) active, after this user's read cursor; a deleted issue reads as read.
  @lazy get unread(): boolean {
    const row = this.readFacts()
    if (row === undefined || row.deletedAt) return false
    if (this.readObservation.blocked) return true
    if (this.readObservation.viewing) return false
    const durable = this.host.visibleInputs.issueRead(this.id)
    const seen = this.readObservation.seenAt
    const read = parseMs(seen && (!durable || seen > durable) ? seen : durable)
    if (read === null) return true
    const updated = this.updatedMs, active = parseMs(this.lastActivityAt)
    if ((updated !== null && updated > read) || (active !== null && active > read)) return true
    // Standalone row feeds can omit replica metadata. Borrow the maintained
    // non-shell member activity, as the old raw unread answer did.
    const inputs = this.host.visibleInputs
    const memberActivity = inputs.seatSummary
      ? inputs.seatList(this.id).length === 0 ? null : inputs.seatSummary(this.id).activity
      : this.memberLatestActivity
    return memberActivity !== null && memberActivity > read
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

  /** The raw execution fact does not let an offer hide ongoing computation. */
  @lazy get missionWorking(): boolean {
    for (const id of this.host.relations.many('issue', this.id, 'missionSessions')) {
      if (this.host.sessionObject(id).workingFact) return true
    }
    return false
  }

  /** Birth references survive rehoming. Intermediate attachments (A → B → C)
   * are not retained in this model, so a backlog B can return to "to do". */
  @lazy get missionBucket(): MissionTaskBucket | null {
    const bucket = missionTaskBucket(this, false, false)
    if (bucket === null || bucket === 'done' || bucket === 'working') return bucket
    return missionTaskBucket(this, this.host.relations.size('issue', this.id, 'bornSessions') > 0 || this.host.relations.size('issue', this.id, 'missionSessions') > 0, this.missionWorking)
  }

  // Task progress: formal descendants, independent of sidebar/mission placement.
  get childCount(): number { return this.host.relations.size('issue', this.id, 'treeChildren') }

  get childDoneCount(): number { return this.childCount ? this.finishedChildren : 0 }

  @lazy
  private get finishedChildren(): number {
    return this.host.queries.issueChildCounts(this.id).childDoneCount
  }

  get confirmedWorkingAgents(): number {
    return this.memberCount ? this.confirmedWorkerCount : 0
  }

  @lazy
  private get confirmedWorkerCount(): number {
    let count = 0
    for (const id of this.livePageSessionIds()) if (this.host.sessionObject(id).confirmedWorking) count++
    return count
  }

  /** Unarchived page members from the declared live subset: archived history
   * is never visited, however long it grows. */
  private livePageSessionIds(): Iterable<string> {
    return this.host.relations.subset('issue', this.id, 'pageSessions', 'unarchived')
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
      const row = omitGone(this.host.row('issue', id, 'summary')) as LoadedRow<SliceIssue>
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
      const row = omitGone(this.host.row('issue', id, 'summary')) as LoadedRow<SliceIssue>
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
      get requests() { return model.ownFactRequests },
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
  private get ownFactRequests(): OwnFacts['requests'] {
    return this.readOwnFacts().requests
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
  readonly readObservation = new ReadObservation()
  static override readonly answers = new Set(['archived', 'unread', 'cwd', 'issueId', 'machineId', 'status', 'geometry', 'messageDraft'])

  constructor(id: string, host: ModelHost) {
    super('session', id, host)
  }

  // Chat facts: each reader observes only the field it shows.
  @lazy get agentPhase() {
    return this.agentState?.phase
  }
  @lazy get agentSince(): string | undefined { return this.agentState?.since }
  @lazy({ equals: compareStructural }) get agentError() { return this.agentState?.error }
  @lazy({ equals: compareStructural }) get agentNeed() { return this.agentState?.need }
  @lazy get agentNativeSubagentCount(): number {
    return this.agentState?.nativeSubagentCount ?? this.agentState?.nativeSubagents?.length ?? 1
  }
  /** The turn the agent state belongs to, as the daemon marked it (POD-6397). */
  @lazy get turnStartedAt(): string | undefined { return this.agentState?.turnStartedAt }
  /** The Stop asked for most recently on this session, as its effect record (POD-6397). */
  @lazy get interrupt(): EffectModel | undefined {
    let latest: EffectModel | undefined
    for (const effect of this.effects.ready) {
      if (effect.kind !== SESSION_INTERRUPT_KIND) continue
      if (latest === undefined || effect.createdAt > latest.createdAt) latest = effect
    }
    return latest
  }
  /** A Stop is on its way: waiting to start, or waiting for its turn to end. */
  @lazy get interrupting(): boolean { return this.interrupt?.inFlight === true }
  /**
   * The Stop failed, expired or lost track while the turn it named still runs:
   * when the app offers Kill (POD-6397). A later turn, or none, means the agent
   * stopped after all.
   */
  @lazy get interruptStuck(): boolean {
    const stop = this.interrupt
    if (stop === undefined || !stop.unsuccessful || !isTurnOpen(this.agentState)) return false
    const turn = (stop.input as { turn?: unknown } | null | undefined)?.turn
    return typeof turn !== 'string' || turn === this.turnStartedAt
  }

  /** The model or effort change asked for most recently on this session, as
   *  its effect record (POD-6523): its patch while it waits, the driver's
   *  answer once it ends. */
  @lazy get configureChange(): EffectModel | undefined {
    let latest: EffectModel | undefined
    for (const effect of this.effects.ready) {
      if (effect.kind !== SESSION_CONFIGURE_KIND) continue
      if (latest === undefined || effect.createdAt > latest.createdAt) latest = effect
    }
    return latest
  }

  /** The move to another machine asked for most recently on this session, as
   *  its effect record (POD-6422): where it goes while it waits, the new
   *  working directory or why it did not move once it ends. */
  @lazy get handoff(): EffectModel | undefined {
    let latest: EffectModel | undefined
    for (const effect of this.effects.ready) {
      if (effect.kind !== SESSION_HANDOFF_KIND) continue
      if (latest === undefined || effect.createdAt > latest.createdAt) latest = effect
    }
    return latest
  }
  /** The machine a move still on its way is taking this session to: from the
   *  press, before the server paints its own overlay (`handoffTarget`). */
  @lazy get handingOffTo(): string | undefined {
    const move = this.handoff
    if (move?.inFlight !== true) return undefined
    const machineId = (move.input as { machineId?: unknown } | null | undefined)?.machineId
    return typeof machineId === 'string' ? machineId : undefined
  }

  // Stored session document, published by Draft Sync v2 rather than the meta feed.
  @lazy get messageDraft(): string { return this.host.sessionDrafts?.get(asSessionId(this.id)) ?? '' }
  @action setMessageDraft(text: string): void { this.host.sessionDrafts?.set(asSessionId(this.id), text) }

  // Placement and lifecycle: one scalar per question. A heartbeat replaces the
  // row with only activity changed; these answers stay equal, so their readers
  // (pane stamp, dock routing, dock shell lifecycle) do not run again.
  @lazy get cwd(): string { return this.storedField('cwd') as string }
  @lazy get issueId(): SessionView['issueId'] { return this.storedField('issueId') as SessionView['issueId'] }
  @lazy get machineId(): SessionView['machineId'] { return this.storedField('machineId') as SessionView['machineId'] }
  @lazy get status(): SessionView['status'] { return this.storedField('status') as SessionView['status'] }
  @lazy({ equals: compareStructural }) get geometry(): SessionView['geometry'] {
    return this.storedField('geometry') as SessionView['geometry']
  }

  // Stored fields: declared summaries can answer a field without promoting it.
  @lazy private get residentRow(): StoredRow | typeof LOADING | undefined {
    return omitGone(this.host.row('session', this.id, 'mark')) as StoredRow | typeof LOADING | undefined
  }

  @lazy
  private get declaredRow(): StoredRow | typeof LOADING | undefined {
    return this.residentRow === LOADING
      ? omitGone(this.host.row('session', this.id, 'summary-fields')) as StoredRow | typeof LOADING | undefined
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
    const row = omitGone(this.host.row('session', this.id))
    if (row === LOADING) throw LOADING
    return (row as Record<string, unknown> | undefined)?.[property]
  }

  @lazy
  get exists(): boolean {
    const resident = omitGone(this.host.row('session', this.id, 'mark'))
    if (resident !== LOADING) return resident !== undefined
    const summary = omitGone(this.host.row('session', this.id, 'summary'))
    // A complete declared display summary is a usable session object; a
    // partial cutoff still spends the shared batched load window.
    if (summary && summary !== LOADING && ['sessionId', 'cwd', 'status', 'lastActiveAt', 'title'].every(field => Object.hasOwn(summary, field))) return true
    const row = omitGone(this.host.row('session', this.id))
    if (row === LOADING) throw LOADING
    return row !== undefined
  }

  // Presence: open means present on the task, including a hibernated session.
  @lazy
  get archived(): boolean | undefined {
    const flag = this.host.sessionArchiveField(this.id)
    if (flag !== undefined) return flag
    const row = omitGone(this.host.row('session', this.id, 'mark'))
    if (row === undefined) return undefined
    return Boolean(this.storedField('archived'))
  }

  @lazy
  get open(): boolean { return !this.archived && this.exists && this.status !== 'exited' }

  @lazy
  get onRoster(): boolean { return !this.archived && this.rosterEligible }

  @lazy
  get rosterEligible(): boolean { return this.exists && !this.headless && this.agentKind !== 'shell' }

  @lazy get workingFact(): boolean {
    return this.exists && !this.archived && sessionWorkingFact(this)
  }

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

  // Timing and fleet: one session's contribution, shared by every owner row.
  @lazy({ equals: compareStructural })
  get fleet(): SidebarSessionFacts['fleet'] {
    return fleetOf([this as unknown as SliceSession], () => this.open)
  }

  @lazy get workingMsTotal(): number | undefined { return this.agentState?.workingMsTotal }

  @lazy get unread(): SessionView['unread'] {
    if (this.readObservation.blocked) return true
    if (this.readObservation.viewing) return false
    const seen = this.readObservation.seenAt
    if (seen && this.lastActiveAt <= seen) return false
    return this.storedField('unread') as SessionView['unread']
  }

  @lazy({ equals: compareStructural })
  get workingTimer(): SidebarSessionFacts['working'] {
    if (!this.executing) return undefined
    return { stateSince: this.stateSinceMs, sinceMs: this.stateSinceMs,
      ...(this.workingMsTotal !== undefined ? { baseMs: this.workingMsTotal } : {}) }
  }

  @lazy({ equals: compareStructural })
  get waitingTimer(): NonNullable<SidebarSessionFacts['waitingOpen']> {
    return { stateSince: this.stateSinceMs,
      sinceMs: Date.parse(this.offer?.createdAt ?? '') || this.stateSinceMs }
  }

  @lazy get doneSinceMs(): number { return this.stateSinceMs || 0 }

  // A seat on a coordinated task (POD-2171): one derivation (`coordinatedSeat`)
  // per role, which every coordinated surface reads. Uncoordinated readers keep
  // `word`, `motion` and the rest above, as they were.
  /** Open pending interactions addressed to this session: how many, and the earliest asked. */
  @lazy({ equals: compareStructural })
  get openInteractions(): SeatInteractions { return this.exists ? this.host.sessionOpenInteractions(this.id) : NO_INTERACTIONS }

  /** Its own task is open: a closed task asks nothing of its seats. */
  @lazy get taskOpen(): boolean {
    const issueId = this.exists ? this.issueId : undefined
    return !issueId || this.host.issueObject(issueId).finished !== true
  }

  @lazy({ equals: compareStructural })
  get coordinatorSeat(): CoordinatedSeat { return this.roleSeat('coordinator') }

  @lazy({ equals: compareStructural })
  get delegateSeat(): CoordinatedSeat { return this.roleSeat('delegate') }

  private roleSeat(role: SeatRole): CoordinatedSeat {
    return coordinatedSeat(this as unknown as SeatSessionFacts, role, this.openInteractions, this.taskOpen)
  }

  @lazy get errorClass(): string | null {
    return this.open && this.phase === 'errored' ? this.agentState?.error?.class ?? 'unknown' : null
  }

  @lazy get unstarted(): boolean { return unstarted(this as unknown as SliceSession) }

  // State word (D5): the one answer the deck, the phone and the CLI give.
  @lazy
  get word(): SessionWord {
    if (!this.exists) return 'done'
    const issueId = this.issueId
    const issueClosed = issueId ? this.host.issueObject(issueId).finished === true : false
    return sessionWord(this as unknown as SessionWordFacts, { issueClosed })
  }

  /** Error or Needs you: the two words that carry the colour and the dot. */
  @lazy get attention(): boolean { return wordWantsAttention(this.word) }

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

  // Attention and ordering are session facts shared by the phone inbox and roster.
  @lazy get attentionGroup() { return attentionGroup(this as SessionView) }

  @lazy get recency(): string {
    const deadline = Date.parse(this.snoozedUntil ?? '')
    return effectiveRecency(this as SessionView,
      Number.isFinite(deadline) && this.host.inputs.reached(deadline) ? deadline : -Infinity)
  }

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
  /**
   * The repo's name: the server-decided `repo.name` (POD-6246), else the name
   * the scan gave this lane (a repo the server has no record of yet).
   */
  @lazy get repoName(): string {
    const repoId = this.storedField('repoId')
    const name = typeof repoId === 'string' ? (here(this.host.row('repo', repoId)) as RepoRow | undefined)?.name : undefined
    return typeof name === 'string' && name ? name : String(this.storedField('repoName') ?? '')
  }
  @lazy get branch(): string | null | undefined { return this.storedField('branch') as string | null | undefined }
  constructor(id: string, host: ModelHost) {
    super('worktree', id, host)
  }


}

/**
 * ONE EFFECT RECORD (ADR 12 D5 E2, POD-6397): a one-off action outside the
 * database (a Stop, a merge, a file write) whose status the server moves on the
 * record. Read-only here: no client writes a status. One scalar per question.
 */
export class EffectModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('effect', id, host)
  }

  // Progress and outcome
  @lazy get status(): EffectStatus { return readEffectStatus(String(this.effect?.status ?? 'unknown')) }
  @lazy get stage(): string | undefined { return this.effect?.stage }
  @lazy({ equals: compareStructural }) get error(): EffectError | undefined { return this.effect?.error }
  /** Still on its way: waiting to start, or running. */
  @lazy get inFlight(): boolean { return this.status === 'pending' || this.status === 'running' }
  /** A start: a draft agent's `session.launch`, a named task's `issue.start`
   *  (POD-6408, POD-6410), or a session on an existing issue, `issue.begin` or
   *  `issue.addSession` (POD-6526), which the launch paint reads (POD-6411). */
  @lazy get isStart(): boolean {
    return (
      this.kind === SESSION_LAUNCH_KIND ||
      this.kind === ISSUE_START_KIND ||
      this.kind === ISSUE_BEGIN_KIND ||
      this.kind === ISSUE_ADD_SESSION_KIND
    )
  }
  /** Ended without doing its work, or without saying whether it did. A cancel
   *  is the person's own choice, not a failure. */
  @lazy get unsuccessful(): boolean {
    return this.status === 'failed' || this.status === 'expired' || this.status === 'unknown'
  }
}
export interface EffectModel extends Readonly<Omit<EffectRecordWire, 'id'>>, RelationGetters<'effect'> {}

class RepoModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('repo', id, host)
  }

  /** One addressed facade for every join. Its fields still track independently. */
  @lazy override get row(): Lookup<Readonly<Record<string, unknown>>> {
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
export interface SessionModel extends Readonly<Omit<SessionView, 'archived' | 'condition' | 'messageDraft'>>, RelationGetters<'session'> {}

export interface IssueModel extends Readonly<Pick<IssueProjection, 'priority' | 'visibility' | 'acceptance' | 'assignee'>>, Readonly<Omit<SliceIssue, 'title' | 'stage' | 'readAt' | 'description' | 'gitState'>>, IssueEdits, RelationGetters<'issue'> {
  /** The stored projection uses the full wire contract; summaries only gate loading. */
  readonly gitState?: IssueGitState | null
}

export type ModelOf = {
  account: AccountModel
  member: MemberModel
  device: DeviceModel
  podiumSettings: PodiumSettingsModel
  repository: RepositoryModel
  messageRecord: MessageModel
  pendingInteraction: PendingInteractionModel
  machine: MachineModel
  automation: AutomationModel
  automationRun: AutomationRunModel
  issue: IssueModel &
    Readonly<Omit<SliceIssue, 'title' | 'stage' | 'readAt' | 'description'>> &
    IssueEdits &
    RelationGetters<'issue'>
  session: SessionModel
  worktree: WorktreeModel &
    Readonly<Pick<SliceWorktree, 'path' | 'repoId' | 'repoPath'>> &
    RelationGetters<'worktree'>
  repo: RepoModel & Readonly<RepoRow> & { readonly path?: string } & RelationGetters<'repo'>
  effect: EffectModel
}

/** The installed class registry. Deferred kinds join it before their first model
 * is constructed; generic tables can already ingest all schema entities. */
export type ModelClass = (new (id: string, host: ModelHost) => EntityModel) & Pick<typeof EntityModel, 'answers'>
export const MODEL_CLASSES: Readonly<Partial<Record<EntityName, ModelClass>>> = {
  issue: IssueModel, session: SessionModel, worktree: WorktreeModel, repo: RepoModel,
  effect: EffectModel,
}

for (const [entity, Model] of Object.entries(MODEL_CLASSES) as [EntityName, ModelClass][]) {
  installFields(Model.prototype, entity, Model.answers)
  installRelations(Model.prototype, entity)
}

// Registration contains class metadata only, never rows or per-record objects.
const deferredClasses = observable.map<EntityName, ModelClass | Error>(undefined, { deep: false })
let deferredRequest: Promise<unknown> | undefined
export function loadSyncedModels(): Promise<unknown> {
  return deferredRequest ??= Promise.all([import('./synced-models'), import('./message-models'), import('./requested-models')]).catch(cause => {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    runInAction(() => {
      for (const entity of Object.keys(SCHEMA) as EntityName[])
        if (!MODEL_CLASSES[entity]) deferredClasses.set(entity, error)
    })
  })
}

/** A deferred model read subscribes to its kind until the import settles. No
 * record ingestion happens here: it already happened on the source receipt. */
export function modelClass(entity: EntityName): ModelClass | typeof LOADING {
  const Model = MODEL_CLASSES[entity] ?? deferredClasses.get(entity)
  if (Model instanceof Error) throw Model
  if (Model) return Model
  void loadSyncedModels()
  return LOADING
}

/** Install complete schema fields using the same generic installer as the
 * startup kinds, then wake pending model readers together. */
export function registerModels(schema: Partial<ModelSchema>, models: Partial<Record<EntityName, ModelClass>>): void {
  Object.assign(SCHEMA, schema)
  const entries = Object.entries(models) as [EntityName, ModelClass][]
  for (const [entity, Model] of entries) {
    installFields(Model.prototype, entity, Model.answers)
    installRelations(Model.prototype, entity)
  }
  Object.assign(MODEL_CLASSES, models)
  runInAction(() => {
    for (const [entity, Model] of entries) deferredClasses.set(entity, Model)
  })
}
