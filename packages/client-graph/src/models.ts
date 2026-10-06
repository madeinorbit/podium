import type { SessionView } from '@podium/client-core/session-values'

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
 * DERIVED VALUES USE @lazy GETTERS. Each group is one cached value (a
 * structural computed: an unchanged group keeps its identity and stops the
 * propagation), built the first time a reaction reads it and dropped when
 * nothing observes it (`@podium/mobx-helpers`), so an object costs nothing until its
 * groups are read, and only the groups that are. A group holds several parts
 * computed by the pure part functions
 * (`views.ts`, `worklist/visible.ts`, `worklist/rollup.ts`), which the
 * rebuild runs directly. Every other getter is a plain read of a group, or a
 * part function run inside the one group that needs it. The cut follows the
 * readers (`visible.ts` has the rules): the rank is its own group because
 * the order and the lanes read every visible row's rank; groups read each
 * other's issues one way only (children up, ancestors down, spin-offs
 * across), so no two groups wait on each other.
 */

import { compareStructural, untracked } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import { headerDockSession, headerHostSession, headerWorkingSession } from './header-session'
import type { Residence } from './pool'
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
  rowActivityAtOf,
  rowLoadingOf,
  sessionIdsPartOf,
  unlessWaiting,
  type ViewInputs,
} from './views'
import { type Placement, withWaiting } from './worklist/groups'
import {
  type Aggregate,
  type Attention,
  attentionOf,
  LOADING,
  type Loaded as LoadedRow,
  type OwnAttention,
  type OwnFacts,
  ownFactsOf,
  type Rollup,
  type RollupInputs,
  rollupPartOf,
  type SeatVerdict,
  seatActivityPartOf,
  tipPartOf,
  type UnitOwn,
  type Units,
  unitOwnPartOf,
  unitsBelowPartOf,
  waitingPartOf,
} from './worklist/rollup'
import { type SidebarRoster, sidebarRosterOf } from './worklist/sidebar'
import {
  childIdsPartOf,
  type HeldIssue,
  type HiddenIssue,
  hiddenPresenceOf,
  type IssueFacts,
  issueFactsPartOf,
  keptBelowPartOf,
  laneMemberIdsPartOf,
  type MemberVerdicts,
  memberIdsPartOf,
  memberVerdictsOf,
  type Nesting,
  nestBelowPartOf,
  nestCandidatePartOf,
  nestedPartOf,
  nestingOf,
  type Presence,
  presenceOf,
  type Retention,
  retentionOf,
  type SessionLinks,
  type SessionVisibility,
  type Standing,
  sessionLinksOf,
  spinOffIdsPartOf,
  unreadPartOf,
  type VisibleInputs,
  verdictPartOf,
} from './worklist/visible'

/** What a model reads from its pool. */
export interface ModelHost {
  /** The pool's one row reader (`MobxPool.row`): pending edits overlaid, `LOADING` when not in memory. */
  row(entity: EntityName, id: string, absent?: 'mark' | 'summary'): LoadedRow<object>
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
          const row = this.row as Readonly<Record<string, unknown>> | undefined
          return row === undefined ? undefined : row[property]
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

/** The own row's in-memory read, cached (`IssueModel.loaded`). */
export interface Loaded {
  readonly facts: OwnFacts
  readonly label: Label
  /** `issue.discoveredFrom`, resolved by the engine: a known origin, or null. */
  readonly originRef: string | null
}

/** Roll-ups carry seat ids and plain facts (POD-5423): compared by value. */
function sameAttention(a: Attention, b: Attention): boolean {
  return compareStructural(a.ownAttention, b.ownAttention) && compareStructural(a.aggregate, b.aggregate)
}

function sameVerdict(a: LoadedRow<SeatVerdict>, b: LoadedRow<SeatVerdict>): boolean {
  if (a === b) return true
  if (a === LOADING || b === LOADING || a === undefined || b === undefined) return false
  return compareStructural(a, b)
}


/** The shared issue and its row fields. Each former cached group remains one
 * lazy value, including bundles; plain projections keep their existing reads. */
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


  // ------------------------------------------------------------- the groups

  @lazy({ equals: compareStructural })
  get facts(): IssueFacts | undefined {
    return issueFactsPartOf(this.host.visibleInputs, this.id)
  }

  @lazy({ equals: compareStructural })
  get rank(): RowRank | undefined {
    const part = this.facts?.part
    return part === undefined ? undefined : rankOfPart(this.id, part)
  }

  /** Explicit seats are judged per seat change; a heartbeat reads no seat history. */
  @lazy({ equals: compareStructural })
  get members(): MemberVerdicts {
    return memberVerdictsOf(this.host.visibleInputs, this.id, this.standing, this)
  }

  @lazy({ equals: compareStructural })
  get presence(): Presence {
    const hidden = this.hidden
    return hidden === undefined
      ? presenceOf(this.host.visibleInputs, this.id, this)
      : hiddenPresenceOf(this.host.visibleInputs, this.id, hidden, this)
  }

  get nesting(): Nesting {
    // An absent row has no placement or candidate to cache. Keep the
    // presence dependency so a later rescue starts the ordinary walk.
    if (!this.present) {
      return nestingOf(this.host.visibleInputs, this.id, undefined, false, null)
    }
    // A present root with no provenance has no candidate or cycle to resolve.
    // Keep tracking presence and standing so a later parent/starter builds
    // the ordinary cached walk, without two memo entries for every root.
    const standing = this.standing
    if (standing === undefined || (standing.parentId === null && standing.startedBy === null)) {
      return nestingOf(this.host.visibleInputs, this.id, standing, true, null)
    }
    return this.nestingValue
  }

  // Keep the root/absent shortcuts outside the lazy fields: those reads
  // need neither a candidate nor a nesting cache.
  @lazy({ equals: compareStructural })
  private get nestingValue(): Nesting {
    const present = this.present
    return nestingOf(
      this.host.visibleInputs,
      this.id,
      present ? this.standing : undefined,
      present,
      this.nestCandidate,
    )
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

  @lazy({ equals: compareStructural })
  get tip(): import('./worklist/rollup').Tip {
    return tipPartOf(this.host.rollupInputs, this.id)
  }

  @lazy({ equals: sameAttention })
  get attention(): Attention {
    return attentionOf(this.host.rollupInputs, this.id, this)
  }

  /** One resident row read (queuing a cold load) supplies facts, label and origin. */
  @lazy({ equals: compareStructural })
  get loaded(): Loaded {
    const row = this.host.rollupInputs.loadedIssue(this.id)
    return {
      facts: ownFactsOf(row),
      label: labelOfRow(this.host.inputs, this.id, row === LOADING ? undefined : row),
      originRef: originRefPartOf(this.host.inputs, this.id),
    }
  }

  @lazy
  get inMemory(): boolean {
    return this.loaded.facts.state === 'ready'
  }

  @lazy({ equals: compareStructural })
  get rowRollup(): Rollup {
    return this.host.inputs.rollup(this.id) ?? NO_ROLLUP
  }

  // ------------------------------------------ the row (RowView, L1b): the fields

  @lazy
  get displayRef(): string {
    return this.label.displayRef ?? ''
  }

  @lazy
  get title(): string {
    return this.label.displayTitle ?? ''
  }

  @lazy
  get phase(): SlicePhase {
    return this.rowRollup.phase
  }

  @lazy
  get progressDone(): number {
    return this.rowRollup.progressDone
  }

  @lazy
  get progressTotal(): number {
    return this.rowRollup.progressTotal
  }

  @lazy
  get working(): boolean {
    return this.rowRollup.working
  }

  @lazy
  get asking(): boolean {
    return this.rowRollup.asking
  }

  @lazy
  get workingSince(): number | null {
    return this.rowRollup.workingSince
  }

  @lazy
  get band(): 0 | 1 | 2 {
    return this.own?.band ?? 1
  }

  @lazy
  get repoKey(): string {
    return this.own?.repoKey ?? ''
  }

  @lazy
  get closed(): boolean {
    return unlessWaiting(this.own?.closed === true, this.rowRollup)
  }

  @lazy
  get dismissed(): boolean {
    return unlessWaiting(this.own?.dismissed === true, this.rowRollup)
  }

  @lazy
  get pinned(): boolean {
    return this.own?.pinned === true
  }

  @lazy
  get sortKey(): string | null {
    return this.own?.sortKey ?? null
  }

  @lazy
  get createdAt(): string {
    return this.own?.createdAt ?? ''
  }

  @lazy
  get seq(): number {
    return this.own?.seq ?? 0
  }

  @lazy
  get foldAt(): string {
    return this.own?.foldAt ?? ''
  }

  @lazy({ equals: compareStructural })
  get originTick(): RowOriginTick | null {
    return originTickPartOf(this.host.inputs, this.originId)
  }

  @lazy
  get activityAt(): number {
    return rowActivityAtOf(this.ownActivityAt, this.rowRollup)
  }

  @lazy
  get loading(): true | undefined {
    return rowLoadingOf(this.lazyLoading, this.rowRollup)
  }

  /** The selection local (a keyed read: only a change of THIS row's selection notifies). */
  get selected(): boolean {
    return this.host.inputs.selected(this.id)
  }

  // --------------------------------------------------- reads of the groups

  get standing(): Standing | undefined {
    return this.facts?.standing
  }

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

  get retainedSeatIds(): readonly string[] {
    return this.members.retainedSeatIds
  }

  get rosterIds(): readonly string[] {
    return this.members.rosterIds
  }

  get retained(): boolean {
    return this.members.retained
  }

  get liveRoster(): boolean {
    return this.members.liveRoster
  }

  get openOwn(): boolean {
    return this.members.openOwn
  }

  get flat(): boolean {
    return this.presence.flat
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

  get keeps(): boolean {
    return this.presence.keeps
  }

  get present(): boolean {
    return this.presence.present
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

  get nestParent(): string | null {
    return this.nesting.nestParent
  }

  get placed(): boolean {
    return this.nesting.placed
  }

  get visible(): boolean {
    return this.nesting.visible
  }

  get ownAttention(): OwnAttention {
    return this.attention.ownAttention
  }

  get aggregate(): Aggregate {
    return this.attention.aggregate
  }

  /** Latest seat activity in the visible subtree, independent of attention. */
  @lazy
  get seatActivity(): number | null {
    return seatActivityPartOf(this.host.rollupInputs, this.id, this)
  }

  @lazy({ equals: compareStructural })
  get unitOwn(): UnitOwn {
    return unitOwnPartOf(this.host.rollupInputs, this.id, this)
  }

  /** Compose formal children's units apart from the issue's own contribution. */
  @lazy({ equals: compareStructural })
  get unitsBelow(): Units {
    return unitsBelowPartOf(this.host.rollupInputs, this.id)
  }

  get label(): Label {
    return this.loaded.label
  }

  /** The row's own-row fields; undefined when the issue is unknown. */
  get own(): OwnPart | undefined {
    return this.facts?.part
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
    const settled = this.facts?.placement
    return settled === undefined || !settled.closed || !this.waiting
      ? settled
      : withWaiting(settled)
  }

  get ownFacts(): OwnFacts {
    return this.loaded.facts
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

  get originRef(): string | null {
    return this.loaded.originRef
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
}

/** THE session: its row, and what its issues read of it. */
export class SessionModel extends EntityModel implements SessionVisibility {
  @lazy({ equals: compareStructural })
  get headerWorking() {
    return headerWorkingSession(this.row as SessionView | undefined, this.host.inputs.passed)
  }

  @lazy({ equals: compareStructural })
  get headerHost() {
    return headerHostSession(this.row as SessionView | undefined)
  }

  @lazy({ equals: compareStructural })
  get headerDock() {
    return headerDockSession(this.row as SessionView | undefined)
  }

  constructor(id: string, host: ModelHost) {
    super('session', id, host)
  }

  /** Its part in its issue's visibility, hot or cold. */
  @lazy({ equals: compareStructural })
  get retention(): Retention | null {
    return retentionOf(this.host.visibleInputs.sessionRow(this.id))
  }

  /** Its `lastActiveAt`, hot or cold: the unread rollup's and the row's activity stamp. */
  @lazy
  get activityMs(): number | null {
    return activityMsOf(this.host.visibleInputs.sessionRow(this.id))
  }

  @lazy({ equals: compareStructural })
  get links(): SessionLinks {
    return sessionLinksOf(this.host.visibleInputs, this.id)
  }

  /** The seat's roll-up verdict, from the RESIDENT row; `LOADING` while it is cold. */
  @lazy({ equals: sameVerdict })
  get verdict(): LoadedRow<SeatVerdict> {
    return verdictPartOf(this.host.visibleInputs, this.id)
  }

  get issueLink(): string | null {
    return this.links.issueLink
  }

  get worktreeLink(): string | null {
    return this.links.worktreeLink
  }
}

class WorktreeModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('worktree', id, host)
  }

  @lazy({ equals: compareStructural })
  get roster(): SidebarRoster {
    return sidebarRosterOf(this.host, this.id)
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
export type ModelOf = {
  issue: IssueModel &
    Readonly<Omit<SliceIssue, 'unread' | 'title' | 'stage' | 'readAt' | keyof RowView>> &
    IssueEdits &
    RelationGetters<'issue'>
  session: SessionModel & Readonly<SliceSession> & RelationGetters<'session'>
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
