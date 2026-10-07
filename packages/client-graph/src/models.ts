import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId, isFinished } from '@podium/model/browser'
import { CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS } from '@podium/model'
import type { TaskProgress } from '@podium/client-core/values'
import { motionPhase as sessionMotion } from '@podium/client-core/values'

/**
 * The pool's models: ONE object per row, one class per schema entity, built
 * by the pool the first time anything asks for it (Linear's "observable on
 * first access"; audit §7). Ingest never builds one. The worklist asks for
 * the issues it holds (`worklist/visible.ts`), a drawn row for its own, and
 * both get the same object: an issue has no second, parallel object.
 *
 * A MODEL HOLDS NO ROW. It reads its row through the pool's one reader on
 * every access (`row`, `MobxPool.row`: the server row with pending edits
 * overlaid), a tracked read of exactly that table slot and its overlay entry,
 * so a model cannot go stale, needs no write-through, shows the same value as
 * its row view, and a replaced or re-added row reaches the same model.
 *
 * FIELDS FROM THE SCHEMA. Every declared field of the entity
 * (`SCHEMA[entity].fields`) is a getter on the model's prototype, installed
 * by `installFields` below from the schema itself: no field list is typed
 * here. The key field answers the model's id; every other field reads the
 * row's property of the same name, or its feed spelling (`FEED_SPELLING` in
 * `shared/src/repo-from-lane.ts`). `models.test.ts` iterates the schema and
 * reads every field off a model.
 *
 * RELATIONS FROM THE SCHEMA (POD-4758). Every declared relation is a getter
 * too, installed by `installRelations` from `SCHEMA[entity].relations` and
 * typed from the declared schema (`RelationGetters`, `shared/src/links.ts`):
 * a misspelled relation does not compile. A single relation answers the
 * target's object, `LOADING` while a cold target loads (only a lazy relation
 * can, Rule L, and its type says so), or null (no target, or a known one
 * with no row: an issue's own checkout that no scan reported). A collection
 * answers a `LazyCollection`: its members in memory, as objects, and how
 * many are loading; each subset it declares is a collection of its own
 * (`worktree.sessions.issueless`). They read through the pool's
 * relation reader. Part functions do not navigate objects: the rebuild runs them
 * over plain maps, where there are none, so they read the same typed names
 * by id (`ViewInputs.links`, `VisibleInputs.links`).
 *
 * THE ISSUE IS ITS ROW (POD-4756). `IssueModel` implements `RowView` (L1b):
 * a drawn row receives the issue object itself and is an `observer` reading
 * its fields (`react/row.tsx`); no row view object is built. Each field is
 * its own cached value, so a row redraws exactly when a field it shows
 * changes. Five of the row's fields are also schema fields (`title`, `seq`,
 * `createdAt`, `pinned`, `sortKey`): the ROW's getter answers them
 * (`IssueModel.answers`), so `issue.title` is the title as the row shows it (a
 * draft's derived name; any other issue's own title, pending edit included)
 * and `issue.pinned` a boolean. The row as fed stays at `issue.row`. The
 * setters stay the schema's: `issue.title = x` edits the title.
 *
 * EDITS, LINEAR'S SHAPE. Every field the write contract declares editable
 * (`EDITABLE_FIELDS`, `write/commands.ts`) also has a setter:
 * `issue.title = x` is `issue.update({ title: x })`, and `update(patch)` is
 * ONE transaction of the write layer's edit log (`write/edit.ts`: paint at
 * once, remember the prior values, send). Reading the field afterwards shows
 * the pending value, because the getter reads the one reader. Without a write
 * layer the pool refuses the edit.
 *
 * DERIVED VALUES USE @lazy GETTERS. Each cached field answers one question,
 * is retained while observed; unwatched reads reuse a value for the current
 * synchronous work (`@podium/mobx-helpers`). An unread field allocates no cache. Independent
 * parts never share a cached record: the compatibility records below expose
 * getter views of the individual fields, so reading a part tracks only that
 * answer. Pure part functions (`views.ts`, `worklist/visible.ts`,
 * `worklist/rollup.ts`) also serve the from-scratch rebuild. Shared work may
 * run once per demanded answer; no alternate model or write index is added.
 * Cross-issue reads still run children up, ancestors down, spin-offs across.

 */

import { compareStructural, untracked } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import { headerDockSession, headerHostSession, headerWorkingSession } from './header-session'
import type { Residence } from './pool'
import type { SeatRelation } from './session-seats'
import type { CollectionName, IsLazy, SingleName, SubsetName, TargetOf } from './shared/links'
import { createRowOverlay } from './shared/overlay-row'
import type { RelationReader } from './shared/relation-reader'
import { FEED_SPELLING } from './shared/repo-from-lane'
import {
  ROW_VIEW_FIELDS,
  type RowOriginTick,
  type RowRank,
  type RowView,
} from './shared/row-view'

const overlayRow = createRowOverlay()

import { type EntityName, SCHEMA } from './shared/schema'
import type { SliceIssue, SlicePhase, SliceSession, SliceWorktree } from './shared/slice-types'
import {
  type EditableStage,
  type EditPatch,
  EDITABLE_FIELDS,
  type TxId,
  type WritableKind,
} from './write/commands'
import type { StoredRow } from './tables'
import {
  activityAtOf,
  activityMsOf,
  ownPartOfRow,
  type Label,
  labelOfRow,
  loadingPartOf,
  NO_ROLLUP,
  type OwnPart,
  originIdPartOf,
  originRefPartOf,
  originTickPartOf,
  prefixPartOf,
  type RepoRow,
  rankOfPart,
  repoTargetPartOf,
  sessionIdsPartOf,
  type ViewInputs,
} from './views'
import { type Placement, placementOfPart, withWaiting } from './worklist/groups'
import { NO_SEATS, type SeatSummary } from './worklist/seat-verdicts'
import {
  type Aggregate,
  aggregateFields,
  ownAttentionFields,
  unitOwnFields,
  unitsBelowFields,
  LOADING,
  type Loaded as LoadedRow,
  type OwnAttention,
  type OwnFacts,
  ownFactsOf,
  type Rollup,
  type RollupInputs,
  rollupPartOf,
  type SeatVerdict,
  attentionGroup,
  isSessionWorking,
  isOfferOnlyAttention,
  motionPhase,
  phaseOf,
  askingOf,
  seatActivityPartOf,
  tipPartOf,
  type UnitOwn,
  type Units,
  waitingPartOf,
} from './worklist/rollup'
import { type SidebarRoster, sidebarRosterOf } from './worklist/sidebar'
import { fleetOf, unstarted, type SidebarSessionFacts, type SidebarSessionOrder } from './worklist/sidebar-row'
import {
  childIdsPartOf,
  type HeldIssue,
  type HiddenIssue,
  hiddenPresenceOf,
  keptBelowPartOf,
  laneMemberIdsPartOf,
  memberIdsPartOf,
  nestBelowPartOf,
  nestCandidatePartOf,
  nestParentPartOf,
  nestedPartOf,
  flatPartOf,
  keepsPartOf,
  retainedSeatIdsPartOf,
  rosterIdsPartOf,
  openOwnPartOf,
  laneRetainedSeatIdsPartOf,
  mergeIds,
  standingOf,
  type Retention,
  retentionOf,
  type SessionVisibility,
  type Standing,
  spinOffIdsPartOf,
  unreadPartOf,
  type VisibleInputs,
} from './worklist/visible'

/** What a model reads from its pool. */
export interface ModelHost {
  /** The pool's one row reader (`MobxPool.row`): pending edits overlaid, `LOADING` when not in memory. */
  row(entity: EntityName, id: string, absent?: 'mark' | 'summary'): LoadedRow<object>
  /** The pool's shared session object, including an addressed cold session. */
  sessionObject(id: string): SessionModel
  issueObject(id: string): IssueModel
  /** Addressed raw archived field, independent of payload/residency. */
  sessionArchiveField(id: string): boolean | undefined
  /** Whether the cutoff declares a stored session field, even when optional. */
  sessionSummaryField(property: string): boolean
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

export class EntityModel {
  /**
   * The schema fields this class answers with its own getter (`installFields`
   * keeps it and adds only the setter). None, but the issue's row fields.
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
 * unless the class names it in `answers` (the issue's row fields): then the
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

/** The shared issue and its row fields. Each lazy value answers one question.
 * Compatibility records contain getters, so reading one part observes only
 * that part; the records themselves are never cached. */
export class IssueModel extends EntityModel implements HeldIssue, RowView {
  /** The schema fields the row answers (`installFields`): the row's value of them, not the fed row's. */
  static override readonly answers: ReadonlySet<string> = new Set<string>(ROW_VIEW_FIELDS)

  constructor(id: string, host: ModelHost) {
    super('issue', id, host)
  }

  /** Edit this issue: one transaction of the write layer's log (paint, remember, send). */
  update(patch: EditPatch<'issue'>): TxId {
    return this.host.edit('issue', this.id, patch)
  }


  // Presence and sidebar placement

  /** Shared fields read the resident slot; cold sidebar rules keep their own summary input. */
  private residentIssue(): SliceIssue | undefined {
    const row = this.host.row('issue', this.id, 'mark')
    return row === LOADING ? this.host.visibleInputs.issueRow(this.id) : row as SliceIssue | undefined
  }

  @lazy
  private get hasStanding(): boolean {
    return this.residentIssue() !== undefined
  }

  private readStanding(): Standing | undefined {
    const row = this.residentIssue()
    return row === undefined ? undefined : standingOf(row)
  }

  private readOwn(): OwnPart | undefined {
    const row = this.residentIssue()
    return row === undefined ? undefined : ownPartOfRow(row, this.host.inputs)
  }

  @lazy({ equals: compareStructural })
  get rank(): RowRank | undefined {
    const part = this.own
    return part === undefined ? undefined : rankOfPart(this.id, part)
  }

  /** R2's already judged summary, without enumerating its seat history. */
  private get explicitSeats(): SeatSummary | undefined {
    const input = this.host.visibleInputs
    return input.seatSummary === undefined
      ? undefined
      : input.seatList(this.id).length === 0 ? NO_SEATS : input.seatSummary(this.id)
  }

  @lazy({ equals: compareStructural })
  private get laneRetainedSeatIds(): readonly string[] {
    return laneRetainedSeatIdsPartOf(this.host.visibleInputs, this.id, this.standing, this.laneMemberIds)
  }

  @lazy({ equals: compareStructural })
  get retainedSeatIds(): readonly string[] {
    const standing = this.standing
    if (standing === undefined) return []
    const summary = this.explicitSeats
    return summary === undefined
      ? retainedSeatIdsPartOf(this.host.visibleInputs, this.id, standing, this.memberIds)
      : mergeIds(summary.retained, this.laneRetainedSeatIds)
  }

  // R2 already owns this list. Pass through its identity instead of adding
  // a second observed cache with a different first-demand lifetime.
  get rosterIds(): readonly string[] {
    if (this.standing === undefined) return []
    const summary = this.explicitSeats
    return summary === undefined
      ? rosterIdsPartOf(this.host.visibleInputs, this.retainedSeatIds)
      : mergeIds(summary.roster, rosterIdsPartOf(this.host.visibleInputs, this.laneRetainedSeatIds))
  }

  @lazy
  get retained(): boolean {
    const standing = this.standing
    return standing !== undefined && !standing.excluded && this.retainedSeatIds.length > 0
  }

  @lazy
  get liveRoster(): boolean {
    return this.rosterIds.length > 0
  }

  @lazy
  get openOwn(): boolean {
    const summary = this.explicitSeats
    return summary === undefined
      ? openOwnPartOf(this.host.visibleInputs, this.id, this.seatIds, this.standing)
      : summary.present > 0 || this.standing?.headlessStaffed === true
  }

  @lazy
  get flat(): boolean {
    return this.hidden === undefined && flatPartOf(this.host.visibleInputs, this.id, this)
  }

  @lazy
  get keeps(): boolean {
    const hidden = this.hidden
    return hidden === undefined
      ? keepsPartOf(this.host.visibleInputs, this.id, this)
      : hiddenPresenceOf(this.host.visibleInputs, this.id, hidden, this).keeps
  }

  @lazy
  get present(): boolean {
    if (this.hidden !== undefined) return false
    const standing = this.standing
    return standing !== undefined && !standing.excluded &&
      (this.flat || (standing.rescuable && this.keeps))
  }

  // Root and absent shortcuts need no parent candidate or cycle cache.
  get nestParent(): string | null {
    if (!this.present) return null
    const standing = this.standing
    if (standing === undefined || (standing.parentId === null && standing.startedBy === null)) return null
    return this.nestParentValue
  }

  @lazy
  private get nestParentValue(): string | null {
    return nestParentPartOf(this.host.visibleInputs, this.id, this.nestCandidate)
  }

  @lazy
  get placed(): boolean {
    if (!this.present) return false
    const parent = this.nestParent
    return parent !== null
      ? this.host.visibleInputs.issue(parent)?.placed === true
      : this.standing?.agent === false
  }

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

  @lazy({ equals: compareStructural })
  private get nestCandidateValue(): string | null {
    const present = this.present
    return nestCandidatePartOf(
      this.host.visibleInputs,
      this.id,
      present ? this.standing : undefined,
      present,
    )
  }

  @lazy({ equals: compareStructural })
  get nestBelow(): readonly string[] {
    return nestBelowPartOf(this.host.visibleInputs, this.id)
  }

  @lazy({ equals: compareStructural })
  get nested(): readonly string[] {
    return nestedPartOf(this.host.visibleInputs, this.id, this)
  }

  private readTip(): import('./worklist/rollup').Tip {
    return tipPartOf(this.host.rollupInputs, this.id)
  }

  private readOwnAttention(): OwnAttention {
    return ownAttentionFields(this.host.rollupInputs, this)
  }

  private readAggregate(): Aggregate {
    return aggregateFields(this.host.rollupInputs, this.id, this)
  }

  private readOwnFacts(): OwnFacts {
    return ownFactsOf(this.host.rollupInputs.loadedIssue(this.id))
  }

  private readLabel(): Label {
    const row = this.host.rollupInputs.loadedIssue(this.id)
    return labelOfRow(this.host.inputs, this.id, row === LOADING ? undefined : row)
  }

  @lazy
  get inMemory(): boolean {
    return this.ownState === 'ready'
  }

  // Stored fields and display labels (RowView compatibility)

  @lazy
  get displayRef(): string {
    return this.readLabel().displayRef ?? ''
  }

  @lazy
  get title(): string {
    return this.readLabel().displayTitle ?? ''
  }

  @lazy
  get phase(): SlicePhase {
    return this.finished === undefined ? NO_ROLLUP.phase : phaseOf(this.aggregate, this.finished)
  }

  // Task progress: formal descendants, independent of sidebar/mission placement.
  get childCount(): number { return this.host.relations.size('issue', this.id, 'treeChildren') }

  @lazy
  get childDoneCount(): number {
    let done = 0
    for (const id of this.host.relations.many('issue', this.id, 'treeChildren')) {
      const row = this.host.row('issue', id, 'summary') as LoadedRow<SliceIssue>
      if (row === LOADING) throw LOADING
      if (row && isFinished(row)) done++
    }
    return done
  }

  @lazy
  get confirmedWorkingAgents(): number {
    const ids = this.host.sessionSeatIds('pageSessions', this.id, false)
    if (ids === LOADING) throw LOADING
    let count = 0
    for (const id of ids) if (this.host.sessionObject(id).confirmedWorking) count++
    return count
  }

  @lazy({ equals: compareStructural })
  get taskProgress(): TaskProgress | null {
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
  @lazy({ equals: compareStructural })
  get dependents(): readonly { id: string; type: string }[] {
    const result: { id: string; type: string }[] = []
    for (const id of [...this.host.relations.many('issue', this.id, 'pageDependents')].sort()) {
      const row = this.host.row('issue', id, 'summary') as LoadedRow<SliceIssue>
      if (row === LOADING) throw LOADING
      for (const dep of row?.deps ?? []) if (dep.id === this.id) result.push({ id, type: dep.type })
    }
    return result
  }

  // Progress
  @lazy
  get progressDone(): number {
    if (this.finished === undefined) return NO_ROLLUP.progressDone
    return this.unitsBelow.members > 0 ? this.unitsBelow.done : this.unitOwn.done ? 1 : 0
  }

  @lazy
  get progressTotal(): number {
    if (this.finished === undefined) return NO_ROLLUP.progressTotal
    return this.unitsBelow.members > 0 ? this.unitsBelow.units : this.unitOwn.solo ? 1 : 0
  }

  // Presence and attention
  @lazy
  get working(): boolean {
    return this.finished !== undefined && this.aggregate.working
  }

  @lazy
  get asking(): boolean {
    return this.finished !== undefined && askingOf(this.aggregate, this.finished)
  }

  @lazy
  get workingSince(): number | null {
    return this.finished === undefined ? null : this.ownAttention.workingSince
  }

  @lazy
  get band(): 0 | 1 | 2 {
    return this.readOwn()?.band ?? 1
  }

  @lazy
  get repoKey(): string {
    return this.readOwn()?.repoKey ?? ''
  }

  // Close: the sidebar fold has a grace period; finished is the entity lifecycle.
  @lazy
  get closed(): boolean {
    return this.settledClosed && !this.asking
  }

  @lazy
  get dismissed(): boolean {
    return this.settledDismissed && !this.asking
  }

  // Stored fields used by row ordering
  @lazy
  get pinned(): boolean {
    return this.readOwn()?.pinned === true
  }

  @lazy
  get sortKey(): string | null {
    return this.readOwn()?.sortKey ?? null
  }

  @lazy
  get createdAt(): string {
    return this.readOwn()?.createdAt ?? ''
  }

  @lazy
  get seq(): number {
    return this.readOwn()?.seq ?? 0
  }

  @lazy
  get foldAt(): string {
    return this.readOwn()?.foldAt ?? ''
  }

  @lazy({ equals: compareStructural })
  get originTick(): RowOriginTick | null {
    return originTickPartOf(this.host.inputs, this.originId)
  }

  @lazy
  get activityAt(): number {
    const own = this.ownActivityAt, seat = this.seatActivity
    return seat !== null && seat > own ? seat : own
  }

  @lazy
  get loading(): true | undefined {
    return this.lazyLoading || (this.finished !== undefined &&
      (this.aggregate.pending > 0 || this.unitsBelow.pending > 0)) ? true : undefined
  }

  /** The selection local (a keyed read: only a change of THIS row's selection notifies). */
  get selected(): boolean {
    return this.host.inputs.selected(this.id)
  }

  // Links and history

  /** The raw parent the nesting walk follows; a hidden issue's from its summary (POD-4753). */
  get parentRef(): string | null {
    // untracked-read: issue-parent-presence
    if (untracked(() => this.host.row('issue', this.id, 'mark')) !== LOADING) return this.standing?.parentId ?? null
    const summary = this.host.row('issue', this.id, 'summary') as HiddenIssue | typeof LOADING | undefined
    return summary === LOADING ? null : summary?.parentId || null
  }

  /**
   * R2's seats: the maintained sorted list itself (tracked, never copied; a
   * membership change yields one element). POD-5423: no cached copy, so a
   * heartbeat or one seat's change walks no history to rebuild it.
   */
  get seatIds(): readonly string[] {
    return this.host.visibleInputs.seatList(this.id)
  }

  get laneMemberIds(): readonly string[] {
    return laneMemberIdsPartOf(this.host.visibleInputs, this.id)
  }

  get memberIds(): readonly string[] {
    return memberIdsPartOf(this.seatIds, this.laneMemberIds)
  }

  get hidden(): HiddenIssue | undefined {
    // untracked-read: issue-hidden-presence
    const resident = untracked(() => this.host.row('issue', this.id, 'mark'))
    if (resident !== LOADING) {
      // Unknown ids must still follow a later cold publication through the reader.
      if (resident === undefined) void this.host.row('issue', this.id, 'summary')
      return undefined
    }
    const summary = this.host.row('issue', this.id, 'summary')
    return summary === LOADING ? {} : summary as HiddenIssue | undefined
  }

  get nestCandidate(): string | null {
    // Cycle walks can ask a root or an absent row for its candidate without
    // going through `nesting`. Their constant null needs no memo either.
    if (!this.present) return null
    const standing = this.standing
    if (standing === undefined || (standing.parentId === null && standing.startedBy === null)) {
      return null
    }
    return this.nestCandidateValue
  }

  /** Latest seat activity in the visible subtree, independent of attention. */
  @lazy
  get seatActivity(): number | null {
    return seatActivityPartOf(this.host.rollupInputs, this.id, this)
  }

  private readUnitOwn(): UnitOwn {
    return unitOwnFields(this.host.rollupInputs, this.id, this)
  }

  private readUnitsBelow(): Units {
    return unitsBelowFields(this.host.rollupInputs, this.id)
  }

  get label(): Label {
    const model = this
    return {
      get displayRef() { return model.inMemory ? model.displayRef : undefined },
      get displayTitle() { return model.inMemory ? model.title : undefined },
      get seq() { return model.inMemory ? model.seq : undefined },
    }
  }

  /** The own-row fields forward to the same caches the row itself reads. */
  get own(): OwnPart | undefined {
    if (!this.hasStanding) return undefined
    const model = this
    return {
      get band() { return model.band },
      get repoKey() { return model.repoKey },
      get closed() { return model.settledClosed },
      get dismissed() { return model.settledDismissed },
      get pinned() { return model.pinned },
      get sortKey() { return model.sortKey },
      get createdAt() { return model.createdAt },
      get seq() { return model.seq },
      get foldAt() { return model.foldAt },
    }
  }

  @lazy
  private get settledClosed(): boolean {
    return this.readOwn()?.closed === true
  }

  @lazy
  private get settledDismissed(): boolean {
    return this.readOwn()?.dismissed === true
  }

  // ------------------------------------ parts computed where they are read

  get finished(): boolean | undefined {
    return this.standing?.finished
  }

  /** Cycle walks need only the tracked parent key, including on cold ancestors. */
  get formalParent(): string | null {
    return this.host.formalParent(this.id)
  }

  /** R-GROUP 3's "nothing in the subtree waits". */
  get waiting(): boolean {
    return waitingPartOf(this)
  }

  /** The row's roll-up fields; undefined when the issue is unknown. */
  get rollup(): Rollup | undefined {
    return rollupPartOf(this)
  }

  /**
   * Where the row goes (R-GROUP, `groups.ts`): read by the groups' layout for
   * visible rows only. The waiting roll-up is read only for a row the fold
   * would take, so a row that could never fold never reads its aggregate.
   */
  get placement(): Placement | undefined {
    const part = this.own
    const row = this.host.visibleInputs.issueRow(this.id)
    const settled = part === undefined || row === undefined ? undefined : placementOfPart(part, row.repoPath)
    return settled === undefined || !settled.closed || !this.waiting
      ? settled
      : withWaiting(settled)
  }

  get childIds(): readonly string[] {
    return childIdsPartOf(this.host.visibleInputs, this.id)
  }

  get spinOffIds(): readonly string[] {
    return spinOffIdsPartOf(this.host.visibleInputs, this.id)
  }

  get keptBelow(): boolean {
    return keptBelowPartOf(this.host.visibleInputs, this.id, this.childIds, this)
  }

  get unread(): boolean {
    return unreadPartOf(this.host.visibleInputs, this.id, this.standing, this.seatIds)
  }

  get repoTarget(): string | null {
    return repoTargetPartOf(this.host.inputs, this.id)
  }

  get prefix(): string | null {
    return prefixPartOf(this.host.inputs, this.repoTarget)
  }

  @lazy
  get originRef(): string | null {
    return originRefPartOf(this.host.inputs, this.id)
  }

  get originId(): string | null {
    return originIdPartOf(this.host.inputs, this.originRef)
  }

  get sessionIds(): readonly string[] {
    return sessionIdsPartOf(this.host.inputs, this.id)
  }

  /** The own-row activity stamp, before the roll-up's latest seat raises it (`activityAt`). */
  get ownActivityAt(): number {
    const inputs = this.host.inputs
    return activityAtOf(
      inputs,
      inputs.retainedSeats(this.id),
      () => this.standing?.updatedMs ?? null,
    )
  }

  /** A lazy input of the row's own parts (the origin, a member session) is not resident yet. */
  get lazyLoading(): boolean {
    return loadingPartOf(this.host.inputs, this.originRef, this.sessionIds)
  }
  // ------------------------------------------------------ own-row standing

  get standing(): Standing | undefined {
    if (!this.hasStanding) return undefined
    const model = this
    return {
      get excluded() { return model.standingExcluded },
      get finished() { return model.standingFinished },
      get agent() { return model.standingAgent },
      get activeHuman() { return model.standingActiveHuman },
      get awaitingMerge() { return model.standingAwaitingMerge },
      get sessionless() { return model.standingSessionless },
      get rescuable() { return model.standingRescuable },
      get parentId() { return model.standingParentId },
      get startedBy() { return model.standingStartedBy },
      get draftVessel() { return model.standingDraftVessel },
      get finishedMs() { return model.standingFinishedMs },
      get updatedMs() { return model.standingUpdatedMs },
      get replicaActivityMs() { return model.standingReplicaActivityMs },
      get headlessStaffed() { return model.standingHeadlessStaffed },
      get deleted() { return model.standingDeleted },
      get pinned() { return model.standingPinned },
      get formalParent() { return model.standingFormalParent },
    }
  }

  @lazy
  private get standingExcluded(): Standing['excluded'] {
    return this.readStanding()!.excluded
  }

  @lazy
  private get standingFinished(): Standing['finished'] {
    return this.readStanding()!.finished
  }

  @lazy
  private get standingAgent(): Standing['agent'] {
    return this.readStanding()!.agent
  }

  @lazy
  private get standingActiveHuman(): Standing['activeHuman'] {
    return this.readStanding()!.activeHuman
  }

  @lazy
  private get standingAwaitingMerge(): Standing['awaitingMerge'] {
    return this.readStanding()!.awaitingMerge
  }

  @lazy
  private get standingSessionless(): Standing['sessionless'] {
    return this.readStanding()!.sessionless
  }

  @lazy
  private get standingRescuable(): Standing['rescuable'] {
    return this.readStanding()!.rescuable
  }

  @lazy
  private get standingParentId(): Standing['parentId'] {
    return this.readStanding()!.parentId
  }

  @lazy
  private get standingStartedBy(): Standing['startedBy'] {
    return this.readStanding()!.startedBy
  }

  @lazy
  private get standingDraftVessel(): Standing['draftVessel'] {
    return this.readStanding()!.draftVessel
  }

  @lazy
  private get standingFinishedMs(): Standing['finishedMs'] {
    return this.readStanding()!.finishedMs
  }

  @lazy
  private get standingUpdatedMs(): Standing['updatedMs'] {
    return this.readStanding()!.updatedMs
  }

  @lazy
  private get standingReplicaActivityMs(): Standing['replicaActivityMs'] {
    return this.readStanding()!.replicaActivityMs
  }

  @lazy
  private get standingHeadlessStaffed(): Standing['headlessStaffed'] {
    return this.readStanding()!.headlessStaffed
  }

  @lazy
  private get standingDeleted(): Standing['deleted'] {
    return this.readStanding()!.deleted
  }

  @lazy
  private get standingPinned(): Standing['pinned'] {
    return this.readStanding()!.pinned
  }

  @lazy
  private get standingFormalParent(): Standing['formalParent'] {
    return this.readStanding()!.formalParent
  }

  // ------------------------------------------------------ resident decision facts

  get ownFacts(): OwnFacts {
    const model = this
    return {
      get state() { return model.ownState },
      get finished() { return model.ownFactFinished },
      get decision() { return model.ownFactDecision },
      get continuedByField() { return model.ownFactContinuedByField },
      get updatedAt() { return model.ownFactUpdatedAt },
      get closedAt() { return model.ownFactClosedAt },
      get coordinatorSessionId() { return model.ownFactCoordinatorSessionId },
      get order() { return model.ownFactOrder },
    }
  }

  @lazy
  private get ownState(): OwnFacts['state'] {
    const state = this.host.resident('issue', this.id)
    return state === 'resident' ? 'ready' : state === 'loading' ? 'cold' : 'unknown'
  }

  @lazy
  private get ownFactFinished(): OwnFacts['finished'] {
    return this.standing?.finished ?? false
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

  @lazy({ equals: compareStructural })
  private get ownFactOrder(): OwnFacts['order'] {
    return this.readOwnFacts().order
  }

  // ------------------------------------------------------ own-seat attention

  get ownAttention(): OwnAttention {
    const model = this
    return {
      get cold() { return model.ownAttentionCold },
      get workingSince() { return model.ownAttentionWorkingSince },
      get firstSessionId() { return model.ownAttentionFirstSessionId },
      get railWaiting() { return model.ownAttentionRailWaiting },
      get sessionIds() { return model.ownAttentionSessionIds },
      get sidebarFacts() { return model.ownAttentionSidebarFacts },
      get updatedAt() { return model.ownAttentionUpdatedAt },
      get order() { return model.ownAttentionOrder },
      get decidingAt() { return model.ownAttentionDecidingAt },
      get seated() { return model.ownAttentionSeated },
      get working() { return model.ownAttentionWorking },
      get deciding() { return model.ownAttentionDeciding },
      get open() { return model.ownAttentionOpen },
      get finished() { return model.ownAttentionFinished },
      get pending() { return model.ownAttentionPending },
    }
  }

  @lazy
  private get ownAttentionCold(): OwnAttention['cold'] {
    return this.readOwnAttention().cold
  }

  @lazy
  private get ownAttentionWorkingSince(): OwnAttention['workingSince'] {
    return this.readOwnAttention().workingSince
  }

  @lazy
  private get ownAttentionFirstSessionId(): OwnAttention['firstSessionId'] {
    return this.readOwnAttention().firstSessionId
  }

  private get ownAttentionRailWaiting(): NonNullable<Aggregate['railWaiting']> | undefined {
    if (!this.ownAttentionRailWaitingPresent) return undefined
    const model = this
    return {
      get open() { return model.ownAttentionRailWaitingOpen },
      get finished() { return model.ownAttentionRailWaitingFinished },
      get decisions() { return model.ownAttentionRailWaitingDecisions },
    }
  }

  @lazy
  private get ownAttentionRailWaitingPresent(): boolean {
    return this.readOwnAttention().railWaiting !== undefined
  }

  @lazy
  private get ownAttentionRailWaitingOpen(): NonNullable<Aggregate['railWaiting']>['open'] {
    return this.readOwnAttention().railWaiting!.open
  }

  @lazy
  private get ownAttentionRailWaitingFinished(): NonNullable<Aggregate['railWaiting']>['finished'] {
    return this.readOwnAttention().railWaiting!.finished
  }

  @lazy
  private get ownAttentionRailWaitingDecisions(): NonNullable<Aggregate['railWaiting']>['decisions'] {
    return this.readOwnAttention().railWaiting!.decisions
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSessionIds(): OwnAttention['sessionIds'] {
    return this.readOwnAttention().sessionIds
  }

  private get ownAttentionSidebarFacts(): SidebarSessionFacts | undefined {
    if (!this.ownAttentionSidebarFactsPresent) return undefined
    const model = this
    return {
      get fleet() { return model.ownAttentionSidebarFactsFleet },
      get working() { return model.ownAttentionSidebarFactsWorking },
      get waitingOpen() { return model.ownAttentionSidebarFactsWaitingOpen },
      get waitingFinished() { return model.ownAttentionSidebarFactsWaitingFinished },
      get doneSince() { return model.ownAttentionSidebarFactsDoneSince },
      get totalMs() { return model.ownAttentionSidebarFactsTotalMs },
      get errorClass() { return model.ownAttentionSidebarFactsErrorClass },
      get allUnstarted() { return model.ownAttentionSidebarFactsAllUnstarted },
    }
  }

  @lazy
  private get ownAttentionSidebarFactsPresent(): boolean {
    return this.readOwnAttention().sidebarFacts !== undefined
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSidebarFactsFleet(): SidebarSessionFacts['fleet'] {
    return this.readOwnAttention().sidebarFacts!.fleet
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSidebarFactsWorking(): SidebarSessionFacts['working'] {
    return this.readOwnAttention().sidebarFacts!.working
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSidebarFactsWaitingOpen(): SidebarSessionFacts['waitingOpen'] {
    return this.readOwnAttention().sidebarFacts!.waitingOpen
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionSidebarFactsWaitingFinished(): SidebarSessionFacts['waitingFinished'] {
    return this.readOwnAttention().sidebarFacts!.waitingFinished
  }

  @lazy
  private get ownAttentionSidebarFactsDoneSince(): SidebarSessionFacts['doneSince'] {
    return this.readOwnAttention().sidebarFacts!.doneSince
  }

  @lazy
  private get ownAttentionSidebarFactsTotalMs(): SidebarSessionFacts['totalMs'] {
    return this.readOwnAttention().sidebarFacts!.totalMs
  }

  @lazy
  private get ownAttentionSidebarFactsErrorClass(): SidebarSessionFacts['errorClass'] {
    return this.readOwnAttention().sidebarFacts!.errorClass
  }

  @lazy
  private get ownAttentionSidebarFactsAllUnstarted(): SidebarSessionFacts['allUnstarted'] {
    return this.readOwnAttention().sidebarFacts!.allUnstarted
  }

  @lazy
  private get ownAttentionUpdatedAt(): OwnAttention['updatedAt'] {
    return this.readOwnAttention().updatedAt
  }

  @lazy({ equals: compareStructural })
  private get ownAttentionOrder(): OwnAttention['order'] {
    return this.readOwnAttention().order
  }

  @lazy
  private get ownAttentionDecidingAt(): OwnAttention['decidingAt'] {
    return this.readOwnAttention().decidingAt
  }

  @lazy
  private get ownAttentionSeated(): OwnAttention['seated'] {
    return this.readOwnAttention().seated
  }

  @lazy
  private get ownAttentionWorking(): OwnAttention['working'] {
    return this.readOwnAttention().working
  }

  @lazy
  private get ownAttentionDeciding(): OwnAttention['deciding'] {
    return this.readOwnAttention().deciding
  }

  private get ownAttentionOpen(): import('./worklist/rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.ownAttentionOpenWaiting },
      get working() { return model.ownAttentionOpenWorking },
      get allDone() { return model.ownAttentionOpenAllDone },
    }
  }

  @lazy
  private get ownAttentionOpenWaiting(): import('./worklist/rollup').PhaseFlags['waiting'] {
    return this.readOwnAttention().open.waiting
  }

  @lazy
  private get ownAttentionOpenWorking(): import('./worklist/rollup').PhaseFlags['working'] {
    return this.readOwnAttention().open.working
  }

  @lazy
  private get ownAttentionOpenAllDone(): import('./worklist/rollup').PhaseFlags['allDone'] {
    return this.readOwnAttention().open.allDone
  }

  private get ownAttentionFinished(): import('./worklist/rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.ownAttentionFinishedWaiting },
      get working() { return model.ownAttentionFinishedWorking },
      get allDone() { return model.ownAttentionFinishedAllDone },
    }
  }

  @lazy
  private get ownAttentionFinishedWaiting(): import('./worklist/rollup').PhaseFlags['waiting'] {
    return this.readOwnAttention().finished.waiting
  }

  @lazy
  private get ownAttentionFinishedWorking(): import('./worklist/rollup').PhaseFlags['working'] {
    return this.readOwnAttention().finished.working
  }

  @lazy
  private get ownAttentionFinishedAllDone(): import('./worklist/rollup').PhaseFlags['allDone'] {
    return this.readOwnAttention().finished.allDone
  }

  @lazy
  private get ownAttentionPending(): OwnAttention['pending'] {
    return this.readOwnAttention().pending
  }

  // ------------------------------------------------------ nested attention

  get aggregate(): Aggregate {
    const model = this
    return {
      get railWaiting() { return model.aggregateRailWaiting },
      get sessionIds() { return model.aggregateSessionIds },
      get sidebarFacts() { return model.aggregateSidebarFacts },
      get updatedAt() { return model.aggregateUpdatedAt },
      get order() { return model.ownAttentionOrder },
      get decidingAt() { return model.aggregateDecidingAt },
      get seated() { return model.aggregateSeated },
      get working() { return model.aggregateWorking },
      get deciding() { return model.aggregateDeciding },
      get open() { return model.aggregateOpen },
      get finished() { return model.aggregateFinished },
      get pending() { return model.aggregatePending },
    }
  }

  private get aggregateRailWaiting(): NonNullable<Aggregate['railWaiting']> | undefined {
    const model = this
    return {
      get open() { return model.aggregateRailWaitingOpen },
      get finished() { return model.aggregateRailWaitingFinished },
      get decisions() { return model.aggregateRailWaitingDecisions },
    }
  }

  @lazy
  private get aggregateRailWaitingOpen(): NonNullable<Aggregate['railWaiting']>['open'] {
    return this.readAggregate().railWaiting!.open
  }

  @lazy
  private get aggregateRailWaitingFinished(): NonNullable<Aggregate['railWaiting']>['finished'] {
    return this.readAggregate().railWaiting!.finished
  }

  @lazy
  private get aggregateRailWaitingDecisions(): NonNullable<Aggregate['railWaiting']>['decisions'] {
    return this.readAggregate().railWaiting!.decisions
  }

  @lazy({ equals: compareStructural })
  private get aggregateSessionIds(): Aggregate['sessionIds'] {
    return this.readAggregate().sessionIds
  }

  private get aggregateSidebarFacts(): SidebarSessionFacts | undefined {
    const model = this
    return {
      get fleet() { return model.aggregateSidebarFactsFleet },
      get working() { return model.aggregateSidebarFactsWorking },
      get waitingOpen() { return model.aggregateSidebarFactsWaitingOpen },
      get waitingFinished() { return model.aggregateSidebarFactsWaitingFinished },
      get doneSince() { return model.aggregateSidebarFactsDoneSince },
      get totalMs() { return model.aggregateSidebarFactsTotalMs },
      get errorClass() { return model.aggregateSidebarFactsErrorClass },
      get allUnstarted() { return model.aggregateSidebarFactsAllUnstarted },
    }
  }

  @lazy({ equals: compareStructural })
  private get aggregateSidebarFactsFleet(): SidebarSessionFacts['fleet'] {
    return this.readAggregate().sidebarFacts!.fleet
  }

  @lazy({ equals: compareStructural })
  private get aggregateSidebarFactsWorking(): SidebarSessionFacts['working'] {
    return this.readAggregate().sidebarFacts!.working
  }

  @lazy({ equals: compareStructural })
  private get aggregateSidebarFactsWaitingOpen(): SidebarSessionFacts['waitingOpen'] {
    return this.readAggregate().sidebarFacts!.waitingOpen
  }

  @lazy({ equals: compareStructural })
  private get aggregateSidebarFactsWaitingFinished(): SidebarSessionFacts['waitingFinished'] {
    return this.readAggregate().sidebarFacts!.waitingFinished
  }

  @lazy
  private get aggregateSidebarFactsDoneSince(): SidebarSessionFacts['doneSince'] {
    return this.readAggregate().sidebarFacts!.doneSince
  }

  @lazy
  private get aggregateSidebarFactsTotalMs(): SidebarSessionFacts['totalMs'] {
    return this.readAggregate().sidebarFacts!.totalMs
  }

  @lazy
  private get aggregateSidebarFactsErrorClass(): SidebarSessionFacts['errorClass'] {
    return this.readAggregate().sidebarFacts!.errorClass
  }

  @lazy
  private get aggregateSidebarFactsAllUnstarted(): SidebarSessionFacts['allUnstarted'] {
    return this.readAggregate().sidebarFacts!.allUnstarted
  }

  @lazy
  private get aggregateUpdatedAt(): Aggregate['updatedAt'] {
    return this.readAggregate().updatedAt
  }

  @lazy
  private get aggregateDecidingAt(): Aggregate['decidingAt'] {
    return this.readAggregate().decidingAt
  }

  @lazy
  private get aggregateSeated(): Aggregate['seated'] {
    return this.readAggregate().seated
  }

  @lazy
  private get aggregateWorking(): Aggregate['working'] {
    return this.readAggregate().working
  }

  @lazy
  private get aggregateDeciding(): Aggregate['deciding'] {
    return this.readAggregate().deciding
  }

  private get aggregateOpen(): import('./worklist/rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.aggregateOpenWaiting },
      get working() { return model.aggregateOpenWorking },
      get allDone() { return model.aggregateOpenAllDone },
    }
  }

  @lazy
  private get aggregateOpenWaiting(): import('./worklist/rollup').PhaseFlags['waiting'] {
    return this.readAggregate().open.waiting
  }

  @lazy
  private get aggregateOpenWorking(): import('./worklist/rollup').PhaseFlags['working'] {
    return this.readAggregate().open.working
  }

  @lazy
  private get aggregateOpenAllDone(): import('./worklist/rollup').PhaseFlags['allDone'] {
    return this.readAggregate().open.allDone
  }

  private get aggregateFinished(): import('./worklist/rollup').PhaseFlags {
    const model = this
    return {
      get waiting() { return model.aggregateFinishedWaiting },
      get working() { return model.aggregateFinishedWorking },
      get allDone() { return model.aggregateFinishedAllDone },
    }
  }

  @lazy
  private get aggregateFinishedWaiting(): import('./worklist/rollup').PhaseFlags['waiting'] {
    return this.readAggregate().finished.waiting
  }

  @lazy
  private get aggregateFinishedWorking(): import('./worklist/rollup').PhaseFlags['working'] {
    return this.readAggregate().finished.working
  }

  @lazy
  private get aggregateFinishedAllDone(): import('./worklist/rollup').PhaseFlags['allDone'] {
    return this.readAggregate().finished.allDone
  }

  @lazy
  private get aggregatePending(): Aggregate['pending'] {
    return this.readAggregate().pending
  }

  // Progress: formal descendants

  get unitOwn(): UnitOwn {
    const model = this
    return {
      get state() { return model.unitOwnState },
      get staffed() { return model.unitOwnStaffed },
      get member() { return model.unitOwnMember },
      get unit() { return model.unitOwnUnit },
      get done() { return model.unitOwnDone },
      get solo() { return model.unitOwnSolo },
      get cold() { return model.unitOwnCold },
    }
  }

  @lazy
  private get unitOwnState(): UnitOwn['state'] {
    return this.readUnitOwn().state
  }

  @lazy
  private get unitOwnStaffed(): UnitOwn['staffed'] {
    return this.readUnitOwn().staffed
  }

  @lazy
  private get unitOwnMember(): UnitOwn['member'] {
    return this.readUnitOwn().member
  }

  @lazy
  private get unitOwnUnit(): UnitOwn['unit'] {
    return this.readUnitOwn().unit
  }

  @lazy
  private get unitOwnDone(): UnitOwn['done'] {
    return this.readUnitOwn().done
  }

  @lazy
  private get unitOwnSolo(): UnitOwn['solo'] {
    return this.readUnitOwn().solo
  }

  @lazy
  private get unitOwnCold(): UnitOwn['cold'] {
    return this.readUnitOwn().cold
  }

  get unitsBelow(): Units {
    const model = this
    return {
      get progress() { return model.unitsBelowProgress },
      get staffed() { return model.unitsBelowStaffed },
      get members() { return model.unitsBelowMembers },
      get units() { return model.unitsBelowUnits },
      get done() { return model.unitsBelowDone },
      get pending() { return model.unitsBelowPending },
    }
  }

  @lazy({ equals: compareStructural })
  private get unitsBelowProgress(): Units['progress'] {
    return this.readUnitsBelow().progress
  }

  @lazy
  private get unitsBelowStaffed(): Units['staffed'] {
    return this.readUnitsBelow().staffed
  }

  @lazy
  private get unitsBelowMembers(): Units['members'] {
    return this.readUnitsBelow().members
  }

  @lazy
  private get unitsBelowUnits(): Units['units'] {
    return this.readUnitsBelow().units
  }

  @lazy
  private get unitsBelowDone(): Units['done'] {
    return this.readUnitsBelow().done
  }

  @lazy
  private get unitsBelowPending(): Units['pending'] {
    return this.readUnitsBelow().pending
  }

  // Links: continuation and origins

  get tip(): import('./worklist/rollup').Tip {
    const model = this
    return {
      get found() { return model.tipFound },
      get pending() { return model.tipPending },
      get target() { return model.tipFound ? model.tipTarget : undefined },
    }
  }

  @lazy
  private get tipFound(): boolean {
    return this.readTip().found
  }

  @lazy
  private get tipPending(): number {
    return this.readTip().pending
  }

  get tipTarget(): import('./worklist/rollup').TipTarget {
    const model = this
    return {
      get id() { return model.tipTargetId },
      get seq() { return model.tipTargetSeq },
      get repoId() { return model.tipTargetRepoId },
      get staffed() { return model.tipTargetStaffed },
      get finished() { return model.tipTargetFinished },
      get activeAt() { return model.tipTargetActiveAt },
    }
  }

  @lazy
  private get tipTargetId(): import('./worklist/rollup').TipTarget['id'] {
    return this.readTip().target!.id
  }

  @lazy
  private get tipTargetSeq(): import('./worklist/rollup').TipTarget['seq'] {
    return this.readTip().target!.seq
  }

  @lazy
  private get tipTargetRepoId(): import('./worklist/rollup').TipTarget['repoId'] {
    return this.readTip().target!.repoId
  }

  @lazy
  private get tipTargetStaffed(): import('./worklist/rollup').TipTarget['staffed'] {
    return this.readTip().target!.staffed
  }

  @lazy
  private get tipTargetFinished(): import('./worklist/rollup').TipTarget['finished'] {
    return this.readTip().target!.finished
  }

  @lazy
  private get tipTargetActiveAt(): import('./worklist/rollup').TipTarget['activeAt'] {
    return this.readTip().target!.activeAt
  }

}

/** THE session: its row, and what its issues read of it. */
export class SessionModel extends EntityModel implements SessionVisibility {
  static override readonly answers = new Set(['archived'])

  constructor(id: string, host: ModelHost) {
    super('session', id, host)
  }

  // Stored fields: declared summaries can answer a field without promoting it.
  override storedField(property: string): unknown {
    const resident = this.host.row('session', this.id, 'mark')
    if (resident !== LOADING) return (resident as Record<string, unknown> | undefined)?.[property]
    const summary = this.host.row('session', this.id, 'summary')
    if (summary && summary !== LOADING && this.host.sessionSummaryField(property)) return (summary as Record<string, unknown>)[property]
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
  get asking(): boolean {
    return !this.archived && this.exists && (this.phase === 'needs_user' || this.phase === 'errored' || Boolean(this.offer))
  }

  /** Confirmed execution expires at this session's deadline, never on a board-wide tick. */
  @lazy
  get confirmedWorking(): boolean {
    if (this.archived || !this.exists || this.agentKind === 'shell' || this.status !== 'live') return false
    if (this.phase !== 'working' && this.phase !== 'compacting') return false
    const at = Math.max(...[this.lastActivity, this.agentState?.since, this.agentState?.stateObservedAt]
      .map(stamp => Date.parse(stamp ?? '')).filter(Number.isFinite))
    return Number.isFinite(at) && !this.host.inputs.passed(at + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS)
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

  @lazy
  private get hasRetention(): boolean {
    return this.host.visibleInputs.sessionRow(this.id) !== undefined
  }

  private readRetention(): Retention | null {
    return retentionOf(this.host.visibleInputs.sessionRow(this.id))
  }

  // Close and retention: sidebar history also considers read/grace state

  get retention(): Retention | null {
    if (!this.hasRetention) return null
    const model = this
    return {
      get issueId() { return model.retentionIssueId },
      get archived() { return model.retentionArchived },
      get seat() { return model.retentionSeat },
      get shell() { return model.retentionShell },
      get exited() { return model.retentionExited },
      get finish() { return model.retentionFinish },
      get unread() { return model.retentionUnread },
      get readMs() { return model.retentionReadMs },
    }
  }

  @lazy
  private get retentionIssueId(): Retention['issueId'] {
    return this.host.visibleInputs.sessionRow(this.id)!.issueId
  }

  @lazy
  private get retentionArchived(): Retention['archived'] {
    return this.archived === true
  }

  @lazy
  private get retentionSeat(): Retention['seat'] {
    return !this.retentionArchived && !this.retentionShell
  }

  @lazy
  private get retentionShell(): Retention['shell'] {
    return this.host.visibleInputs.sessionRow(this.id)!.agentKind === 'shell'
  }

  @lazy
  private get retentionExited(): Retention['exited'] {
    return this.host.visibleInputs.sessionRow(this.id)!.status === 'exited'
  }

  @lazy({ equals: compareStructural })
  private get retentionFinish(): Retention['finish'] {
    return this.readRetention()!.finish
  }

  @lazy
  private get retentionUnread(): Retention['unread'] {
    return this.host.visibleInputs.sessionRow(this.id)!.unread === true
  }

  @lazy
  private get retentionReadMs(): Retention['readMs'] {
    const readAt = this.host.visibleInputs.sessionRow(this.id)!.readAt
    return typeof readAt === 'string' && readAt ? Date.parse(readAt) || 0 : null
  }

  @lazy
  private get verdictState(): 'ready' | typeof LOADING | undefined {
    const state = this.host.resident('session', this.id)
    return state === 'resident' ? 'ready' : state === 'loading' ? LOADING : undefined
  }

  private get verdictRow(): SliceSession {
    return this.host.visibleInputs.loadedSession(this.id) as SliceSession
  }

  // Presence: resident sidebar verdicts (LOADING while cold)

  get verdict(): LoadedRow<SeatVerdict> {
    const state = this.verdictState
    if (state !== 'ready') return state
    const model = this
    return {
      get open() { return model.verdictOpen },
      get finished() { return model.verdictFinished },
      get working() { return model.executing },
      get workingSinceMs() { return model.verdictWorkingSinceMs },
      get id() { return model.verdictId },
      get sidebarFacts() { return model.verdictSidebarFacts },
      get sidebarOrder() { return model.verdictSidebarOrder },
    }
  }

  @lazy
  private get verdictOpen(): SeatVerdict['open'] {
    return motionPhase(this.verdictRow, false)
  }

  @lazy
  private get verdictFinished(): SeatVerdict['finished'] {
    return motionPhase(this.verdictRow, true)
  }

  @lazy
  private get verdictWorkingSinceMs(): SeatVerdict['workingSinceMs'] {
    if (!this.executing) return null
    const row = this.verdictRow
    const at = Date.parse(row.agentState?.since ?? row.lastActiveAt)
    return Number.isFinite(at) ? at : null
  }

  private get verdictId(): SeatVerdict['id'] {
    return this.id
  }

  private get verdictSidebarFacts(): SidebarSessionFacts | undefined {
    const model = this
    return {
      get fleet() { return model.verdictSidebarFactsFleet },
      get working() { return model.verdictSidebarFactsWorking },
      get waitingOpen() { return model.verdictSidebarFactsWaitingOpen },
      get waitingFinished() { return model.verdictSidebarFactsWaitingFinished },
      get doneSince() { return model.verdictSidebarFactsDoneSince },
      get totalMs() { return model.verdictSidebarFactsTotalMs },
      get errorClass() { return model.verdictSidebarFactsErrorClass },
      get allUnstarted() { return model.verdictSidebarFactsAllUnstarted },
    }
  }

  @lazy({ equals: compareStructural })
  private get verdictSidebarFactsFleet(): SidebarSessionFacts['fleet'] {
    return fleetOf([this.verdictRow])
  }

  @lazy({ equals: compareStructural })
  private get verdictSidebarFactsWorking(): SidebarSessionFacts['working'] {
    if (!this.executing) return undefined
    const row = this.verdictRow
    const stateSince = Date.parse(row.agentState?.since ?? row.lastActiveAt)
    return { stateSince, sinceMs: stateSince,
      ...(row.agentState?.workingMsTotal !== undefined ? { baseMs: row.agentState.workingMsTotal } : {}) }
  }

  @lazy({ equals: compareStructural })
  private get verdictSidebarFactsWaitingOpen(): SidebarSessionFacts['waitingOpen'] {
    return this.verdictOpen === 'waiting' ? this.verdictWaitingAnchor : undefined
  }

  @lazy({ equals: compareStructural })
  private get verdictSidebarFactsWaitingFinished(): SidebarSessionFacts['waitingFinished'] {
    return this.verdictFinished === 'waiting' ? this.verdictWaitingAnchor : undefined
  }

  @lazy({ equals: compareStructural })
  private get verdictWaitingAnchor(): NonNullable<SidebarSessionFacts['waitingOpen']> {
    const row = this.verdictRow
    const stateSince = Date.parse(row.agentState?.since ?? row.lastActiveAt)
    return { stateSince, sinceMs: Date.parse(row.offer?.createdAt ?? '') || stateSince }
  }

  @lazy
  private get verdictSidebarFactsDoneSince(): SidebarSessionFacts['doneSince'] {
    const row = this.verdictRow
    return Date.parse(row.agentState?.since ?? row.lastActiveAt) || 0
  }

  @lazy
  private get verdictSidebarFactsTotalMs(): SidebarSessionFacts['totalMs'] {
    return this.verdictRow.agentState?.workingMsTotal
  }

  @lazy
  private get verdictSidebarFactsErrorClass(): SidebarSessionFacts['errorClass'] {
    const row = this.verdictRow
    return !row.archived && row.status !== 'exited' && row.agentState?.phase === 'errored'
      ? row.agentState.error?.class ?? 'unknown' : null
  }

  @lazy
  private get verdictSidebarFactsAllUnstarted(): SidebarSessionFacts['allUnstarted'] {
    return unstarted(this.verdictRow)
  }

  private get verdictSidebarOrder(): SidebarSessionOrder | undefined {
    const model = this
    return {
      get id() { return model.verdictSidebarOrderId },
      get working() { return model.verdictSidebarOrderWorking },
      get snoozedUntil() { return model.verdictSidebarOrderSnoozedUntil },
      get recency() { return model.verdictSidebarOrderRecency },
      get createdAt() { return model.verdictSidebarOrderCreatedAt },
      get offerOnly() { return model.verdictSidebarOrderOfferOnly },
    }
  }

  private get verdictSidebarOrderId(): SidebarSessionOrder['id'] {
    return this.id
  }

  @lazy
  private get verdictSidebarOrderWorking(): SidebarSessionOrder['working'] {
    return attentionGroup(this.verdictRow) === 'working'
  }

  @lazy
  private get verdictSidebarOrderSnoozedUntil(): SidebarSessionOrder['snoozedUntil'] {
    return this.verdictRow.snoozedUntil
  }

  @lazy
  private get verdictSidebarOrderRecency(): SidebarSessionOrder['recency'] {
    const row = this.verdictRow
    return row.draftUpdatedAt && row.draftUpdatedAt > row.lastActiveAt ? row.draftUpdatedAt : row.lastActiveAt
  }

  @lazy
  private get verdictSidebarOrderCreatedAt(): SidebarSessionOrder['createdAt'] {
    return this.verdictRow.createdAt ?? ''
  }

  @lazy
  private get verdictSidebarOrderOfferOnly(): SidebarSessionOrder['offerOnly'] {
    return isOfferOnlyAttention(this.verdictRow)
  }

  @lazy
  private get headerWorkingPresent(): boolean {
    return headerWorkingSession(this.row as SessionView | undefined, this.host.inputs.passed) != null
  }

  // Header presentation: screen rules retained for the sidebar follow-up

  get headerWorking(): NonNullable<ReturnType<typeof headerWorkingSession>> | null {
    if (!this.headerWorkingPresent) return null
    const model = this
    return {
      get sessionId() { return model.headerWorkingSessionId },
      get title() { return model.headerWorkingTitle },
      get name() { return model.headerWorkingName },
      get displayRef() { return model.headerWorkingDisplayRef },
      get agentKind() { return model.headerWorkingAgentKind },
    }
  }

  @lazy
  private get headerWorkingSessionId(): NonNullable<ReturnType<typeof headerWorkingSession>>['sessionId'] {
    return (this.row as SessionView).sessionId
  }

  @lazy
  private get headerWorkingTitle(): NonNullable<ReturnType<typeof headerWorkingSession>>['title'] {
    return (this.row as SessionView).title
  }

  @lazy
  private get headerWorkingName(): NonNullable<ReturnType<typeof headerWorkingSession>>['name'] {
    return (this.row as SessionView).name
  }

  @lazy
  private get headerWorkingDisplayRef(): NonNullable<ReturnType<typeof headerWorkingSession>>['displayRef'] {
    return (this.row as SessionView).displayRef
  }

  @lazy
  private get headerWorkingAgentKind(): NonNullable<ReturnType<typeof headerWorkingSession>>['agentKind'] {
    return (this.row as SessionView).agentKind
  }

  @lazy
  private get headerHostPresent(): boolean {
    return headerHostSession(this.row as SessionView | undefined) != null
  }

  get headerHost(): NonNullable<ReturnType<typeof headerHostSession>> | null {
    if (!this.headerHostPresent) return null
    const model = this
    return {
      get cwd() { return model.headerHostCwd },
      get machineId() { return model.headerHostMachineId },
      get archived() { return model.headerHostArchived },
      get status() { return model.headerHostStatus },
      get phase() { return model.headerHostPhase },
      get resumable() { return model.headerHostResumable },
    }
  }

  @lazy
  private get headerHostCwd(): NonNullable<ReturnType<typeof headerHostSession>>['cwd'] {
    return (this.row as SessionView).cwd
  }

  @lazy
  private get headerHostMachineId(): NonNullable<ReturnType<typeof headerHostSession>>['machineId'] {
    return (this.row as SessionView).machineId
  }

  @lazy
  private get headerHostArchived(): NonNullable<ReturnType<typeof headerHostSession>>['archived'] {
    return !!(this.row as SessionView).archived
  }

  @lazy
  private get headerHostStatus(): NonNullable<ReturnType<typeof headerHostSession>>['status'] {
    return (this.row as SessionView).status
  }

  @lazy
  private get headerHostPhase(): NonNullable<ReturnType<typeof headerHostSession>>['phase'] {
    return (this.row as SessionView).agentState?.phase
  }

  @lazy
  private get headerHostResumable(): NonNullable<ReturnType<typeof headerHostSession>>['resumable'] {
    return !!(this.row as SessionView).resumable
  }

  @lazy
  private get headerDockPresent(): boolean {
    return this.host.resident('session', this.id) === 'resident'
  }

  get headerDock(): NonNullable<ReturnType<typeof headerDockSession>> | undefined {
    if (!this.headerDockPresent) return undefined
    const model = this
    return {
      get sessionId() { return model.headerDockSessionId },
      get issueId() { return model.headerDockIssueId },
      get cwd() { return model.headerDockCwd },
      get machineId() { return model.headerDockMachineId },
      get archived() { return model.headerDockArchived },
      get lastActiveAt() { return model.headerDockLastActiveAt },
    }
  }

  @lazy
  private get headerDockSessionId(): NonNullable<ReturnType<typeof headerDockSession>>['sessionId'] {
    return (this.row as SessionView).sessionId
  }

  @lazy
  private get headerDockIssueId(): NonNullable<ReturnType<typeof headerDockSession>>['issueId'] {
    return (this.row as SessionView).issueId
  }

  @lazy
  private get headerDockCwd(): NonNullable<ReturnType<typeof headerDockSession>>['cwd'] {
    return (this.row as SessionView).cwd
  }

  @lazy
  private get headerDockMachineId(): NonNullable<ReturnType<typeof headerDockSession>>['machineId'] {
    return (this.row as SessionView).machineId
  }

  @lazy
  private get headerDockArchived(): NonNullable<ReturnType<typeof headerDockSession>>['archived'] {
    return (this.row as SessionView).archived
  }

  @lazy
  private get headerDockLastActiveAt(): NonNullable<ReturnType<typeof headerDockSession>>['lastActiveAt'] {
    return (this.row as SessionView).lastActiveAt
  }

}

class WorktreeModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('worktree', id, host)
  }

  @lazy({ equals: compareStructural })
  get rosterIds(): readonly string[] {
    return sidebarRosterOf(this.host, this.id).ids
  }

  get roster(): SidebarRoster {
    return { ids: this.rosterIds, pending: 0 }
  }
}

class RepoModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('repo', id, host)
  }
}

/**
 * The issue's editable fields as setters take them (`issue.stage = 'review'`).
 * `title` reads as the row shows it (`IssueModel.title`) and sets the title.
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

export type ModelOf = {
  issue: IssueModel &
    Readonly<Omit<SliceIssue, 'unread' | 'title' | 'stage' | 'readAt' | keyof RowView>> &
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
