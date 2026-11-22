import { isBuiltinHarnessKind } from '@podium/model'
import type { IssueBriefWire, IssueDescriptionWire, IssuePanelTodoWire, IssuePanelArtifactWire, IssuePanelDeferredWire, IssuePanelStateWire } from '@podium/model'
import type { LayoutWire } from '@podium/model'
import { type IssueNavigationModel, issuePendingDecision, missionTaskBucket, type MissionTaskBucket } from '@podium/client-core/values'
import { type LiveStore, lastValue } from '@podium/client-core/live'
import type { Reading, SessionCondition } from '@podium/client-core/live'
import {
  contextUsagePercentOf,
  type ContextAvailability,
  type ContextCapability,
  type ContextCapacity,
  type ContextModelIdentity,
  type ContextOccupancy,
  type ContextReason,
  type ContextSummary,
  type Inventory,
} from '@podium/model/browser'
import type { ConcertmasterEntryWire, EffectError, EffectRecordWire, EffectStatus, InstancePreferences, IssueGitState, IssuePanel, IssuePanelArtifact, IssueProjection, NoticeWire, PersonalPreferences, PinKind, PinWire, ReadPositionWire, SuperagentThreadWire, TabOrderWire } from '@podium/model'
import { type PodiumSettings, resolveRole } from '@podium/runtime'
import { here, isGone, type Lookup, omitGone } from './lookup'
import type { MessageModel, PendingInteractionModel } from './message-models'
import { ReadObservation } from './read-observation'
import { type FeatureId, type FeatureStates, OFFLINE_FEATURE_FACTS, resolveFeatureStates } from '@podium/protocol'
import type { CredentialModel, DeviceModel, MemberModel, RepositoryModel } from './requested-models'
import type { AutomationModel, AutomationRunModel, MachineModel } from './synced-models'

export type { AutomationModel, AutomationRunModel, MachineModel } from './synced-models'
export type {
  AgentProfileModel,
  SubscriptionModel,
  WorkflowBindingModel,
  WorkflowModel,
  WorkflowRevisionModel,
  WorkflowRunModel,
} from './workflow-models'
import type {
  AgentProfileModel,
  SubscriptionModel,
  WorkflowBindingModel,
  WorkflowModel,
  WorkflowRevisionModel,
  WorkflowRunModel,
} from './workflow-models'

import { attentionGroup, effectiveRecency } from '@podium/client-core/focus'
import type { SessionLiveFields, SessionView } from '@podium/client-core/session-values'
import { groupRelations, type IssueCloseMemberCounts, type IssueCloseScalarSubject, type ReferentExit, motionPhase as sessionMotion, type TaskProgress } from '@podium/client-core/values'
import { type AccessRefusal, APPROVAL_EFFECT_KIND, credentialRefusalOfCode, isTurnOpen, readEffectStatus, SESSION_INTERRUPT_KIND } from '@podium/model/browser'
import {
  ISSUE_ADD_SESSION_KIND,
  ISSUE_BEGIN_KIND,
  ISSUE_START_KIND,
  ISSUE_WORK_KINDS,
  SESSION_CONFIGURE_KIND,
  SESSION_HANDOFF_KIND,
  SESSION_LAUNCH_KIND,
} from '@podium/client-core/spawn-agent'
import { asSessionId, type CoordinatedSeat, coordinatedSeat, isSessionReconnecting, sessionWorkingFact, inPersonalSet, isExcluded, isFinished, NO_INTERACTIONS, type SeatInteractions, type SeatRole, type SeatSessionFacts, type SessionWord, type SessionWordFacts, sessionWord, wordWantsAttention } from '@podium/model/browser'
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
import type { IssueChildCounts } from './shared/issue-questions'
import { EDITABLE_FIELDS, type EditableStage, type EditPatch, type TxId, type WritableKind } from './write/commands'

const EMPTY_DEPENDENTS: readonly { id: string; type: string }[] = Object.freeze([])

// Direct work-row paint readers need scalar equality when an unrelated stored
// field changes. Other installed stored getters stay plain.
const ISSUE_PAINT_FIELDS: ReadonlySet<string> = new Set([
  'title', 'audience', 'linearIdentifier', 'seq', 'acceptance',
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
  /** TRACKED: the sessions painted as spawn placeholders (`MobxPool.spawnPlaceholders`). */
  spawnPlaceholders(): ReadonlyMap<string, string | null> | null

  readonly issueSessionFact: IssueSessionFactReader
  /** The pool's one row reader (`MobxPool.row`): pending edits overlaid, `LOADING` when not in memory. */
  row(entity: EntityName, id: string, absent?: 'mark'): Lookup<object>
  /** Did I pin this thing? My `pin` record of that kind (POD-6692). */
  isPinned(kind: PinKind, entityId: string): boolean
  /** The pool's shared session object, including an addressed absent session. */
  sessionObject(id: string): SessionModel
  issueObject(id: string): IssueModel
  /** Addressed raw archived field, independent of payload/residency. */
  sessionArchiveField(id: string): boolean | undefined
  /** Open pending interactions addressed to a session (`MobxPool.sessionOpenInteractions`). */
  sessionOpenInteractions(id: string): SeatInteractions
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
  /** Where a row stands; an absent one answers `loading` and its load starts (first access). */
  resident(entity: EntityName, id: string): Residence
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

/** `to:id`'s object when its row is in memory, `LOADING` while it is on its way (its load started), else null. */
function objectOrLoading(
  host: ModelHost,
  to: EntityName,
  id: string,
): EntityModel | typeof LOADING | null {
  const answer = host.model(to, id)
  return isGone(answer) ? null : answer
}

/** A live collection (Rule L). `ready` is the shallow-equal list of shared
 * models in bucket order (unordered, M3 F1); `loading` counts absent members and
 * starts their loads. Retaining the handle never retains a stale answer. */
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
  static override readonly answers: ReadonlySet<string> = new Set([
    'description',
    'brief',
    'panel',
    'activityNotes',
    'notesUpdatedAt',
  ])
  constructor(id: string, host: ModelHost) {
    super('issue', id, host)
  }

  /** Edit this issue: one transaction of the write layer's log (paint, remember, send). */
  update(patch: EditPatch<'issue'>): TxId {
    return this.host.edit('issue', this.id, patch)
  }


  // Stored fields
  override storedField(property: string): unknown {
    if (property === 'readAt') return this.host.visibleInputs.issueRead(this.id)
    const resident = omitGone(this.host.row('issue', this.id, 'mark'))
    if (resident !== LOADING) return (resident as Record<string, unknown> | undefined)?.[property]
    const row = omitGone(this.host.row('issue', this.id))
    if (row === LOADING) throw LOADING
    return (row as Record<string, unknown> | undefined)?.[property]
  }

  @lazy get authoredTitle(): string {
    return String(this.storedField('title') ?? '')
  }

  // My pin (POD-6692): my `pin` record of kind 'issue' for this task, never a
  // field of its row. Pinning on my other device moves it without a request.
  @lazy get pinned(): boolean {
    return this.host.isPinned('issue', this.id)
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

  // The bodies (POD-6921): the brief and the description are synced records
  // of their own, keyed by the issue id and loaded at start with everything
  // else; a field with no text has no record. A painted row (an edit the log
  // has not settled, a launch, a fixture) holds its own text, which wins.
  /** The agent brief; absent when the issue has none. */
  @lazy get brief(): string | undefined {
    const painted = this.storedField('brief')
    if (painted !== undefined) return painted as string
    return this.briefRecords.ready[0]?.text
  }
  @lazy({ equals: compareShallow }) get panelTodos(): IssuePanelTodoModel[] {
    return this.panelTodoRecords.ready.slice().sort(panelOrder)
  }
  @lazy({ equals: compareShallow }) get panelArtifacts(): IssuePanelArtifactModel[] {
    return this.panelArtifactRecords.ready.slice().sort(panelOrder)
  }
  @lazy({ equals: compareShallow }) get panelDeferred(): IssuePanelDeferredModel[] {
    return this.panelDeferredRecords.ready.slice().sort(panelOrder)
  }
  /** Lists contain shared models, never copied item facts. Membership and order
   * are the only inputs: toggling one todo does not replace any list. */
  @lazy get panel(): IssuePanel {
    return { todos: this.panelTodos, artifacts: this.panelArtifacts, deferred: this.panelDeferred }
  }
  @lazy get activityNotes(): string | undefined { return this.panelStateRecords.ready[0]?.text }
  @lazy get notesUpdatedAt(): string | undefined { return this.panelStateRecords.ready[0]?.updatedAt }

  // Chat uploads (POD-2148): the stored copy of each file attached in one of
  // this issue's chats, by the attachment id it was staged under. The chat
  // shows a thumbnail from it once the daemon's upload sweep deleted the file.
  @lazy get chatUploads(): ReadonlyMap<string, IssuePanelArtifact> {
    const panel = this.panel
    const out = new Map<string, IssuePanelArtifact>()
    for (const artifact of panel?.artifacts ?? [])
      if (artifact.chatUploadId && artifact.artifactId) out.set(artifact.chatUploadId, artifact)
    return out
  }
  /** The human summary's text; empty when there is none. */
  @lazy get description(): string {
    const painted = this.storedField('description')
    if (painted !== undefined) return documentText(painted)
    return this.descriptionRecords.ready[0]?.text ?? ''
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

  // Activity and headless presence: raw ownership maxima/counters from the
  // feed's session facts; they never replace the stored issue record.
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
  /** Children and done children over all history, from the stubs (POD-7088). */
  get childProgress(): IssueChildCounts | typeof LOADING {
    return this.host.queries.issueChildCounts(this.id)
  }
  /** Throws LOADING until the stubs answer; readers settle it. */
  get closeChildren(): IssueChildCounts {
    const value = this.childProgress
    if (value === LOADING) throw LOADING
    return value
  }
  /** Existing scalar consumers share the raw member fact, without another cache. */
  get sessionSummary() {
    return this.memberSummary
  }



  // Stored fields and presence
  /** The issue's row as the pool holds it; undefined while it is on its way. */
  private readFacts(): SliceIssue | undefined {
    const resident = omitGone(this.host.row('issue', this.id, 'mark'))
    if (resident !== LOADING) return resident as SliceIssue | undefined
    const row = omitGone(this.host.row('issue', this.id))
    return row === LOADING ? undefined : row as SliceIssue | undefined
  }

  @lazy get excluded(): boolean {
    const row = this.readFacts()
    return row !== undefined && isExcluded(row)
  }

  @lazy get inMemory(): boolean { return this.host.resident('issue', this.id) === 'resident' }
  /** Where the issue stands: here, on its way (its load started), or absent. */
  @lazy get residence(): Residence { return this.host.resident('issue', this.id) }
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
  /** The issue's number, read from its row. */
  @lazy get displayRef(): string {
    const seq = this.readFacts()?.seq
    return seq === undefined ? '' : displayRefOf(seq, this.prefix)
  }
  @lazy get repoTarget(): string | null { return repoTargetPartOf(this.host.inputs, this.id) }
  @lazy get prefix(): string | null { return prefixPartOf(this.host.inputs, this.repoTarget) }
  @lazy get originRef(): string | null { return originRefPartOf(this.host.inputs, this.id) }
  @lazy get parentRef(): string | null { return this.readFacts()?.parentId || null }
  get formalParent(): string | null { return this.host.formalParent(this.id) }
  /** The parent is archived or deleted (`CloseFacts.parentGone`). */
  @lazy get parentGone(): boolean {
    const parentId = this.parentRef
    if (parentId === null) return false
    // Pool filing observes this after a view closes: a maintenance read
    // must neither request the parent nor inherit the view's lookup hold.
    const parent = omitGone(this.host.row('issue', parentId, 'mark'))
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

  /** Present non-shell members, by session id: unarchived, held by the pool
   * (no load), and not folded into a resumed twin. A heartbeat never re-sorts this list. */
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
  /** Over all history from the stubs; throws LOADING until they answer (`childProgress`). */
  get childCount(): number { return this.closeChildren.childCount }

  get childDoneCount(): number { return this.closeChildren.childDoneCount }

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
      const row = omitGone(this.host.row('issue', id)) as LoadedRow<SliceIssue>
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
      const row = omitGone(this.host.row('issue', id)) as LoadedRow<SliceIssue>
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
  static override readonly answers = new Set(['archived', 'unread', 'cwd', 'issueId', 'machineId', 'status', 'messageDraft'])

  constructor(id: string, host: ModelHost) {
    super('session', id, host)
  }

  /** A failed launch on the person's too-old binary can explicitly install Podium's side. */
  @lazy get installRecoveryHarness() {
    if (this.exitCode !== -1 || !this.machineId || !isBuiltinHarnessKind(this.agentKind)) return undefined
    const machine = here(this.host.model('machine', this.machineId))
    const harness = machine?.harnessInstalls.find((row) => row.kind === this.agentKind)
    return harness?.tooOld ? harness : undefined
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

  /** The `session.launch` record that started this session, the latest when
   *  there are several (POD-6408). */
  @lazy get launch(): EffectModel | undefined {
    let latest: EffectModel | undefined
    for (const effect of this.effects.ready) {
      if (effect.kind !== SESSION_LAUNCH_KIND) continue
      if (latest === undefined || effect.createdAt > latest.createdAt) latest = effect
    }
    return latest
  }
  /**
   * Why this session's start was refused for its credential (credential
   * management §9), read from its launch record's error CODE, never from the
   * sentence: the session that never started says why and offers the way out.
   * Undefined for any other failure, and for a start that ran.
   */
  @lazy get launchRefusal(): AccessRefusal | undefined {
    const launch = this.launch
    return launch?.status === 'failed' ? credentialRefusalOfCode(launch.error?.code) : undefined
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
  /**
   * Running, and its machine is known to be offline right now (ADR 12 D1,
   * POD-6646): a condition read from this user's LiveStore, never a stored
   * status. Before the machine's first reading it is unknown, and unknown is
   * not reconnecting, so an app started offline never shows a stale answer.
   */
  @lazy get reconnecting(): boolean {
    const machineId = this.machineId
    return isSessionReconnecting(this.status, machineId ? this.host.live?.onlineOf(machineId) : undefined)
  }

  // Live readings (POD-6764): conditions from this user's LiveStore, never
  // stored fields. A tracked read holds the session's topic while it is
  // watched. Before the first reading each is unknown (undefined), and a
  // reading that went stale keeps its last value for the next frame.
  /**
   * Where this session's live readings come from: none while it is a spawn
   * placeholder (POD-6854). The server has no row for a placeholder's id yet,
   * so it refuses the session's topics, and a refused key is asked again only
   * after a reconnect. Holding nothing until the row lands sends the first
   * subscribe when the server can answer it, which is also when the terminal
   * mount is released (`paneSpawnConfirmed` reads the same set).
   */
  @lazy private get liveReadings(): LiveStore | undefined {
    return this.host.spawnPlaceholders()?.has(this.id) ? undefined : this.host.live
  }
  /** Writing to its terminal now. Only a running session is asked: a stopped
   *  one is not busy, so a list of finished sessions holds no topic. */
  @lazy get busy(): boolean | undefined {
    const status = this.status
    if (status !== 'live' && status !== 'starting') return false
    const reading = this.liveReadings?.sessionConditionOf(this.id)
    return reading?.known ? reading.value.busy : undefined
  }
  /** The last human input into the session (ISO 8601). */
  @lazy get lastInputAt(): string | undefined {
    return lastValue(this.liveReadings?.sessionConditionOf(this.id))?.lastInputAt
  }
  /** Compatibility only: normalized context wins, including explicit clears
   * and over-capacity percentages that the old wire cannot represent. */
  @lazy get contextUsagePercent(): number | undefined {
    return this.context === undefined
      ? lastValue(this.contextReading)?.contextUsagePercent
      : contextUsagePercentOf(this.context)
  }

  // Context: one atomic live value, and small presentation questions. Native
  // interpretation, capacity lookup and occupancy arithmetic stay in adapters.
  @lazy private get contextRecordState(): 'here' | 'loading' | 'gone' {
    const row = this.row
    return row === LOADING ? 'loading' : isGone(row) ? 'gone' : 'here'
  }
  @lazy private get contextReading(): Reading<SessionCondition> | undefined {
    return this.contextRecordState === 'here'
      ? this.liveReadings?.sessionConditionOf(this.id)
      : undefined
  }
  /** Original observation, including identity, model, accuracy and event time.
   * Requested model changes never relabel it. Offline is derived below. */
  @lazy get context(): ContextSummary | undefined {
    return lastValue(this.contextReading)?.context
  }
  /** The shared machine's context mechanism for this harness × bound driver. Preserve the
   * pool's loading/gone answers, including an absent session or machine. */
  @lazy get contextImplementation(): Lookup<
    NonNullable<Inventory['contextCapabilities']>[number] | undefined
  > {
    const row = this.row
    if (row === LOADING || isGone(row)) return row
    if (!this.machineId) return undefined
    const machine = this.host.model('machine', this.machineId)
    if (machine === LOADING || isGone(machine)) return machine
    return machine.contextCapabilities?.find(
      (driver) => driver.harness === this.agentKind && driver.driverId === this.driverId,
    )
  }
  @lazy get contextCapability(): ContextCapability | undefined {
    return here(this.contextImplementation)?.capability
  }
  @lazy get contextAvailability(): ContextAvailability | undefined {
    return here(this.contextImplementation)?.availability
  }
  /** Implementation support is distinct from native availability and the
   * current session reading. An old inventory is unknown, never unsupported. */
  @lazy get contextSupport(): 'unknown' | 'supported' | 'unsupported' {
    const context = here(this.contextImplementation)
    if (context === undefined) return 'unknown'
    return context.capability === undefined || context.availability.status === 'unsupported'
      ? 'unsupported'
      : 'supported'
  }
  @lazy get contextProvenance(): 'normalized' | 'legacy-percent' | undefined {
    if (this.context !== undefined) return 'normalized'
    return lastValue(this.contextReading)?.contextUsagePercent !== undefined
      ? 'legacy-percent'
      : undefined
  }
  @lazy get contextOccupancy(): ContextOccupancy | undefined {
    const context = this.context
    return context?.status === 'available' || context?.status === 'stale'
      ? context.occupancy
      : undefined
  }
  /** Untruncated adapter percentage. Legacy peers supply only a percentage,
   * with no sample identity, token counts, capacity or rich detail. */
  @lazy get contextPercent(): number | undefined {
    return this.context === undefined
      ? lastValue(this.contextReading)?.contextUsagePercent
      : this.contextOccupancy?.percent?.value
  }
  /** Unit fraction only for drawing the circle; never a reconstructed count. */
  @lazy get contextRatio(): number | undefined {
    return this.contextPercent === undefined ? undefined : Math.min(1, this.contextPercent / 100)
  }
  @lazy get contextRemainingTokens(): number | undefined {
    return this.contextOccupancy?.remainingTokens?.value
  }
  @lazy get contextCapacity(): ContextCapacity | undefined {
    const context = this.context
    return context?.status === 'unsupported' ? undefined : context?.effectiveCapacity
  }
  @lazy get contextCapacityBasis(): ContextCapacity['basis'] | undefined {
    return this.contextCapacity?.basis
  }
  @lazy get contextObservedModel(): ContextModelIdentity | undefined {
    const context = this.context
    return context?.status === 'unsupported' ? undefined : context?.model
  }
  @lazy private get contextCurrent(): boolean {
    return this.contextReading?.known === true && !this.contextSessionUnavailable
  }
  @lazy private get contextSessionUnavailable(): boolean {
    return (
      (this.status !== 'live' && this.status !== 'starting') ||
      (!!this.machineId && this.host.live?.onlineOf(this.machineId) === false)
    )
  }
  /** Transport loss makes a retained measurement stale. Age alone never
   * invalidates an idle online sample, so this getter needs no clock. */
  @lazy get contextState(): ContextSummary['status'] | 'unknown' {
    if (this.contextRecordState === 'loading') return 'unknown'
    if (this.contextRecordState === 'gone' || isGone(this.contextImplementation))
      return 'unavailable'
    const context = this.context
    if (this.contextOccupancy !== undefined || this.contextProvenance === 'legacy-percent')
      return context?.status === 'stale' || !this.contextCurrent ? 'stale' : 'available'
    if (context?.status === 'unsupported') return 'unsupported'
    if (!this.contextCurrent && context !== undefined) return 'unavailable'
    if (context !== undefined) return context.status
    if (this.contextSupport === 'unsupported') return 'unsupported'
    if (this.contextSessionUnavailable) return 'unavailable'
    const availability = this.contextAvailability
    return availability?.status === 'unavailable' ? 'unavailable' : 'unknown'
  }
  @lazy({ equals: compareStructural }) get contextReason(): ContextReason | undefined {
    if (this.contextRecordState === 'gone')
      return { code: 'session-gone', message: 'This session is no longer available' }
    if (isGone(this.contextImplementation))
      return { code: 'machine-gone', message: 'This session’s machine is no longer available' }
    const context = this.context
    if (context && context.status !== 'available') return context.reason
    if (this.contextState === 'stale')
      return {
        code: 'offline',
        message: 'Last context measurement; the live session is unavailable',
      }
    if (this.contextProvenance !== undefined) return undefined
    if (this.contextRecordState === 'here' && this.contextSessionUnavailable)
      return { code: 'offline', message: 'A live context measurement is unavailable' }
    const availability = this.contextAvailability
    return availability?.status === 'available' ? undefined : availability?.reason
  }
  /** Rich reads require an attributable current sample and declared support.
   * They are never offered for the legacy percentage compatibility reading. */
  @lazy get contextDetailLevel(): ContextCapability['detail'] {
    return this.contextProvenance === 'normalized' &&
      this.contextState === 'available' &&
      this.contextSupport === 'supported'
      ? (this.contextCapability?.detail ?? 'none')
      : 'none'
  }
  /** The terminal's size: the server's stored size while nothing runs it, so a
   *  cached terminal view opens at the right size with the daemon offline. */
  @lazy({ equals: compareStructural }) get geometry(): SessionView['geometry'] {
    return lastValue(this.liveReadings?.sessionTerminalStateOf(this.id))?.geometry
  }

  // Stored fields
  @lazy private get residentRow(): StoredRow | typeof LOADING | undefined {
    return omitGone(this.host.row('session', this.id, 'mark')) as StoredRow | typeof LOADING | undefined
  }

  /** The row as the pool holds it, or its load started when the feed is about to bring it. */
  @lazy
  private get declaredRow(): StoredRow | typeof LOADING | undefined {
    return this.residentRow === LOADING
      ? omitGone(this.host.row('session', this.id)) as StoredRow | typeof LOADING | undefined
      : this.residentRow
  }

  /** The pool holds the session's record (without asking for an absent one). */
  @lazy get known(): boolean { return this.residentRow !== undefined && this.residentRow !== LOADING }

  override storedField(property: string): unknown {
    if (this.residentRow !== LOADING) return (this.residentRow as Readonly<Record<string, unknown>> | undefined)?.[property]
    const row = omitGone(this.host.row('session', this.id))
    if (row === LOADING) throw LOADING
    return (row as Record<string, unknown> | undefined)?.[property]
  }

  @lazy
  get exists(): boolean {
    if (this.residentRow !== LOADING) return this.residentRow !== undefined
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
    return this.open && (this.status === 'starting' || this.reconnecting || this.workingMotion)
  }

  @lazy
  // Motion lets an offer/question override execution; verdict.working reports execution alone.
  get motion(): ReturnType<typeof sessionMotion> { return this.exists ? sessionMotion(this as SessionView) : 'queued' }

  @lazy
  get workingMotion(): boolean { return this.motion === 'working' }

  @lazy
  get settled(): boolean { return !this.open || this.motion === 'done' }

  @lazy
  // Execution alone; the sidebar verdict reads more.
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

  /** Fresh execution evidence is a session fact; views decide which agents to show.
   *  A reconnecting session has none: its machine's link is down, so its preserved
   *  phase no longer confirms work now. */
  @lazy
  get computingDeadline(): number | undefined {
    if (this.reconnecting) return undefined
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

  // A human gate (POD-6674)
  /** An agent's request for a management operation, which waits for its person. */
  @lazy get isApproval(): boolean { return this.kind === APPROVAL_EFFECT_KIND }
  /** Waiting for its person to decide: pending, and nobody has. */
  @lazy get awaitingDecision(): boolean { return this.decision === null && this.status === 'pending' }
  /** The request as the agent filed it: the operation and where it came from.
   *  `op` is checked by the screen that shows it (the catalog grows). */
  @lazy({ equals: compareStructural }) get approvalRequest(): ApprovalRequestView | undefined {
    if (!this.isApproval) return undefined
    const input = this.input as Partial<Record<'op' | 'machineId' | 'sessionId' | 'issueId', unknown>> | null | undefined
    if (!input || typeof input.sessionId !== 'string' || typeof input.machineId !== 'string') return undefined
    return {
      op: input.op,
      machineId: input.machineId,
      sessionId: input.sessionId,
      issueId: typeof input.issueId === 'string' ? input.issueId : null,
    }
  }
}

/** What an approval record asks for (`ApprovalEffectInput`, read structurally). */
export interface ApprovalRequestView {
  readonly op: unknown
  readonly machineId: string
  readonly sessionId: string
  readonly issueId: string | null
}
export interface EffectModel extends Readonly<Omit<EffectRecordWire, 'id'>>, RelationGetters<'effect'> {
  /** Stamped at the row-source boundary: the record is routed to the viewer. */
  readonly forViewer?: boolean
}

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
export interface SessionModel extends Readonly<Omit<SessionView, 'archived' | 'condition' | 'messageDraft' | keyof SessionLiveFields>>, RelationGetters<'session'> {}

export interface IssueModel extends Readonly<Pick<IssueProjection, 'priority' | 'visibility' | 'acceptance' | 'assignee'>>, Readonly<Omit<SliceIssue, 'title' | 'stage' | 'readAt' | 'description' | 'gitState'>>, IssueEdits, RelationGetters<'issue'> {
  /** The stored projection uses the full wire contract. */
  readonly gitState?: IssueGitState | null
}

/**
 * MY PER-USER RECORDS (POD-6673): pins, tab orders, personal settings and read
 * positions, synced to every device of mine and to nobody else. One shared model
 * per record; screens read these, never a request.
 */
export class PinModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('pin', id, host)
  }
}
export interface PinModel extends Readonly<PinWire> {}

export class UserLayoutModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('userLayout', id, host)
  }
}
export interface UserLayoutModel extends Readonly<LayoutWire> {}

export class TabOrderModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('tabOrder', id, host)
  }
}
export interface TabOrderModel extends Readonly<TabOrderWire> {}

/**
 * My personal settings, resolved: every leaf I never chose reads as its default
 * (the row source resolves the record's flat leaves). The record is always
 * present for the principal, so a reader never handles "no settings".
 */
export class UserPreferencesModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('userPreferences', id, host)
  }
  // Roles
  /** The harness a coding session starts with when a task leaves its agent on Auto. */
  @lazy get codingHarness(): string {
    return resolveRole({ roles: this.roles } as PodiumSettings, 'coding').harness
  }
  /** Which panel a new session opens on. */
  @lazy get startScreen(): 'native' | 'chat' | 'auto' {
    return this.roles.coding.startScreen
  }
  // Sidebar
  @lazy({ equals: compareShallow }) get repoOrder(): readonly string[] {
    return this.sidebar.repoOrder
  }
}
export interface UserPreferencesModel extends Readonly<Omit<PersonalPreferences, 'userId'>> {
  readonly userId: string
}

export class UserReadPositionModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('userReadPosition', id, host)
  }
}
export interface UserReadPositionModel extends Readonly<ReadPositionWire> {}

/**
 * ONE OF MY SUPERAGENT THREADS (POD-6675): a synced per-user record. Screens
 * read the thread list, its running turn and its last failure here, never a
 * request; a thread made or renamed on my other device arrives on its own.
 */
export class SuperagentThreadModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('superagentThread', id, host)
  }
  /** The always-there global thread (one per person). */
  @lazy get isGlobal(): boolean {
    return this.kind === 'global'
  }
  /** Listed among my open threads. */
  @lazy get isOpen(): boolean {
    return !this.archived
  }
}
export interface SuperagentThreadModel extends Readonly<SuperagentThreadWire> {}

/**
 * ONE OF MY OPEN NOTICES (POD-6881, spec §13): a synced per-user record. The
 * tray and the phone's inbox read it here; a notice resolved on the server
 * leaves the pool on its own.
 */
export class InboxNoticeModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('inboxNotice', id, host)
  }
  /** Not read yet: counted on the tray. */
  @lazy get unread(): boolean {
    return this.readAt === undefined
  }
}
export interface InboxNoticeModel extends Readonly<NoticeWire> {}

/**
 * ONE ENTRY OF A CONCERTMASTER'S CURATED CONVERSATION (POD-7211): a message
 * the agent sent (`say`), one its person sent (`user`), or an ask. The curated
 * chat and the Concertmaster dock panel read it here; an ask settled anywhere
 * moves these fields on its own.
 */
export class ConcertmasterEntryModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('concertmasterEntry', id, host)
  }
  /** An ask of any standing. */
  @lazy get isAsk(): boolean {
    return this.kind === 'ask'
  }
  /** An ask that still needs its person: what the "needs you" list holds. */
  @lazy get open(): boolean {
    return this.kind === 'ask' && this.status === 'open'
  }
}
export interface ConcertmasterEntryModel extends Readonly<ConcertmasterEntryWire> {}

/**
 * THE INSTANCE SETTINGS (POD-6677): one synced record for the whole instance,
 * every member's, resolved with defaults by the row source from its flat leaf
 * fields. Screens read it here, never `settings.get`; an admin's change on any
 * device arrives on its own, and an app started offline paints its saved copy.
 */
export class InstancePreferencesModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('instancePreferences', id, host)
  }
  /** The parent branch new issue worktrees start from; '' detects the repo's default. */
  @lazy get defaultParentBranch(): string {
    return this.gitWorkflow.defaultParentBranch
  }
  /** The host lifecycle policy the header and the machine views show. */
  @lazy({ equals: compareStructural }) get lifecycle(): Pick<
    InstancePreferences,
    'hibernation' | 'worktreeGc'
  > {
    return { hibernation: this.hibernation, worktreeGc: this.worktreeGc }
  }
  /** The load ratio hibernation acts on, or null when load pressure is off. */
  @lazy get loadPerCoreThreshold(): number | null {
    return this.hibernation.enabled ? this.hibernation.loadPerCore : null
  }
  /**
   * Every feature flag resolved: the connected server's facts (its build and
   * config, from `welcome`, held by the LiveStore) joined with this record's
   * experimental toggles and stored update channel. Before the first `welcome`
   * (an app started offline) each flag follows its saved toggle.
   */
  @lazy({ equals: compareStructural }) get features(): FeatureStates {
    return resolveFeatureStates(this.host.live?.connection.serverFeatures ?? OFFLINE_FEATURE_FACTS, {
      experimental: this.experimental,
      updateChannel: this.deployment.updateChannel,
    })
  }
  /** Whether one feature is on for this install. */
  featureEnabled(id: FeatureId): boolean {
    return this.features.flags.find((flag) => flag.id === id)?.enabled ?? false
  }
}
export interface InstancePreferencesModel extends Readonly<InstancePreferences> {}

const panelOrder = (a: { position: number; id: string }, b: { position: number; id: string }) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
export class IssuePanelTodoModel extends EntityModel {
  declare readonly id: import('@podium/model').IssuePanelItemId
  constructor(id: string, host: ModelHost) { super('issuePanelTodo', id, host) }
}
export interface IssuePanelTodoModel extends Readonly<Omit<IssuePanelTodoWire, 'id'>>, RelationGetters<'issuePanelTodo'> {}
export class IssuePanelArtifactModel extends EntityModel {
  declare readonly id: import('@podium/model').IssuePanelItemId
  constructor(id: string, host: ModelHost) { super('issuePanelArtifact', id, host) }
}
export interface IssuePanelArtifactModel extends Readonly<Omit<IssuePanelArtifactWire, 'id'>>, RelationGetters<'issuePanelArtifact'> {}
export class IssuePanelDeferredModel extends EntityModel {
  declare readonly id: import('@podium/model').IssuePanelItemId
  constructor(id: string, host: ModelHost) { super('issuePanelDeferred', id, host) }
}
export interface IssuePanelDeferredModel extends Readonly<Omit<IssuePanelDeferredWire, 'id'>>, RelationGetters<'issuePanelDeferred'> {}
export class IssuePanelStateModel extends EntityModel {
  declare readonly id: import('@podium/model').IssueId
  constructor(id: string, host: ModelHost) { super('issuePanelState', id, host) }
}
export interface IssuePanelStateModel extends Readonly<Omit<IssuePanelStateWire, 'id'>>, RelationGetters<'issuePanelState'> {}
/** An issue's brief, its own synced record keyed by the issue id (POD-6921). */
export class IssueBriefModel extends EntityModel {
  declare readonly id: import('@podium/model').IssueId
  constructor(id: string, host: ModelHost) { super('issueBrief', id, host) }
}
export interface IssueBriefModel extends Readonly<Omit<IssueBriefWire, 'id'>>, RelationGetters<'issueBrief'> {}
/** An issue's description, its own synced record keyed by the issue id (POD-6921). */
export class IssueDescriptionModel extends EntityModel {
  declare readonly id: import('@podium/model').IssueId
  constructor(id: string, host: ModelHost) { super('issueDescription', id, host) }
}
export interface IssueDescriptionModel extends Readonly<Omit<IssueDescriptionWire, 'id'>>, RelationGetters<'issueDescription'> {}

export type ModelOf = {
  issueBrief: IssueBriefModel
  issueDescription: IssueDescriptionModel
  issuePanelTodo: IssuePanelTodoModel
  issuePanelArtifact: IssuePanelArtifactModel
  issuePanelDeferred: IssuePanelDeferredModel
  issuePanelState: IssuePanelStateModel

  credential: CredentialModel
  member: MemberModel
  device: DeviceModel
  instancePreferences: InstancePreferencesModel
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
  pin: PinModel
  userLayout: UserLayoutModel
  tabOrder: TabOrderModel
  userPreferences: UserPreferencesModel
  userReadPosition: UserReadPositionModel
  superagentThread: SuperagentThreadModel
  inboxNotice: InboxNoticeModel
  concertmasterEntry: ConcertmasterEntryModel
  agentProfile: AgentProfileModel
  workflow: WorkflowModel
  workflowRevision: WorkflowRevisionModel
  workflowBinding: WorkflowBindingModel
  workflowRun: WorkflowRunModel
  subscription: SubscriptionModel
}

/** The installed class registry. Deferred kinds join it before their first model
 * is constructed; generic tables can already ingest all schema entities. */
export type ModelClass = (new (id: string, host: ModelHost) => EntityModel) & Pick<typeof EntityModel, 'answers'>
export const MODEL_CLASSES: Readonly<Partial<Record<EntityName, ModelClass>>> = {
  issue: IssueModel, session: SessionModel, worktree: WorktreeModel, repo: RepoModel,
  effect: EffectModel,
  issueBrief: IssueBriefModel,
  issueDescription: IssueDescriptionModel,
  issuePanelTodo: IssuePanelTodoModel,
  issuePanelArtifact: IssuePanelArtifactModel,
  issuePanelDeferred: IssuePanelDeferredModel,
  issuePanelState: IssuePanelStateModel,
  pin: PinModel,
  userLayout: UserLayoutModel, tabOrder: TabOrderModel, userPreferences: UserPreferencesModel,
  userReadPosition: UserReadPositionModel,
  superagentThread: SuperagentThreadModel,
  inboxNotice: InboxNoticeModel,
  concertmasterEntry: ConcertmasterEntryModel,
  instancePreferences: InstancePreferencesModel,
}

for (const [entity, Model] of Object.entries(MODEL_CLASSES) as [EntityName, ModelClass][]) {
  installFields(Model.prototype, entity, Model.answers)
  installRelations(Model.prototype, entity)
}

// Registration contains class metadata only, never rows or per-record objects.
const deferredClasses = observable.map<EntityName, ModelClass | Error>(undefined, { deep: false })
let deferredRequest: Promise<unknown> | undefined
export function loadSyncedModels(): Promise<unknown> {
  return deferredRequest ??= Promise.all([import('./synced-models'), import('./message-models'), import('./requested-models'), import('./workflow-models')]).catch(cause => {
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
