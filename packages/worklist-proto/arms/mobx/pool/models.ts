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
 * EDITS, LINEAR'S SHAPE. Every field the write contract declares editable
 * (`FIELD_COVERAGE`, `shared/src/write-contract.ts`) also has a setter:
 * `issue.title = x` is `issue.update({ title: x })`, and `update(patch)` is
 * ONE transaction of the write layer's edit log (`write/edit.ts`: paint at
 * once, remember the prior values, send). Reading the field afterwards shows
 * the pending value, because the getter reads the one reader. Without a write
 * layer the pool refuses the edit.
 *
 * DERIVED VALUES ARE CACHED IN GROUPS. Each group is one cached value (a
 * structural computed: an unchanged group keeps its identity and stops the
 * propagation) holding several parts computed by the pure part functions
 * (`views.ts`, `worklist/visible.ts`, `worklist/rollup.ts`), which the
 * rebuild runs directly. Every other getter is a plain read of a group, or a
 * part function run inside the one group that needs it. The cut follows the
 * readers (`visible.ts` has the rules): the rank is its own group because
 * the order and the lanes read every visible row's rank; groups read each
 * other's issues one way only (children up, ancestors down, spin-offs
 * across), so no two groups wait on each other.
 */

import { computed, computedStruct, makeObservable } from 'mobx'
import { FEED_SPELLING } from '../../../shared/src/repo-from-lane'
import type { RowOriginTick, RowRank, RowView } from '../../../shared/src/row-view'
import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../../shared/src/slice-types'
import type { ArmStats } from '../../../shared/src/stats'
import {
  type EditableStage,
  type EditPatch,
  FIELD_COVERAGE,
  type TxId,
  type WritableKind,
} from '../../../shared/src/write-contract'
import type { StoredRow } from './tables'
import {
  activityAtPartOf,
  activityMsOf,
  buildRowView,
  type IssueParts,
  type Label,
  labelOfRow,
  loadingPartOf,
  type OwnPart,
  originIdPartOf,
  originRefPartOf,
  originTickPartOf,
  prefixPartOf,
  rankOfPart,
  type RepoRow,
  repoTargetPartOf,
  sessionIdsPartOf,
  type ViewInputs,
} from './views'
import { type Placement, withWaiting } from './worklist/groups'
import {
  type Aggregate,
  type Attention,
  attentionOf,
  formalParentPartOf,
  LOADING,
  type Loaded,
  type OwnAttention,
  type OwnFacts,
  ownFactsOf,
  type Progress,
  progressOf,
  type Rollup,
  type RollupInputs,
  rollupPartOf,
  type SeatVerdict,
  tipPartOf,
  type UnitOwn,
  type Units,
  waitingPartOf,
} from './worklist/rollup'
import {
  childIdsPartOf,
  type HeldIssue,
  type IssueFacts,
  issueFactsPartOf,
  keptBelowPartOf,
  type Members,
  membersOf,
  type Nesting,
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
  verdictPartOf,
  type VisibleInputs,
} from './worklist/visible'

/** What a model reads from its pool. */
export interface ModelHost {
  /** The pool's one row reader (`MobxPool.row`): pending edits overlaid, `LOADING` when not in memory. */
  row(entity: EntityName, id: string): Loaded<object>
  /** What the row view's parts read. */
  readonly inputs: ViewInputs
  /** What the visibility parts read. */
  readonly visibleInputs: VisibleInputs
  /** What the roll-up parts read (one per pool, shared by every issue). */
  readonly rollupInputs: RollupInputs
  readonly stats: ArmStats
  /** One transaction of the write layer's edit log; throws when the pool has no write layer. */
  edit<K extends WritableKind>(entity: K, id: string, patch: EditPatch<K>): TxId
}

export class EntityModel {
  constructor(
    readonly entity: EntityName,
    readonly id: string,
    protected readonly host: ModelHost,
  ) {}

  /** The row as the pool shows it (the one reader: fenced, tracked, pending edits overlaid). */
  get row(): StoredRow | undefined {
    const row = this.host.row(this.entity, this.id)
    return row === LOADING ? undefined : (row as StoredRow | undefined)
  }
}

/** Install one getter per declared field of `entity` on `prototype`, and a setter per editable one. */
function installFields(prototype: EntityModel, entity: EntityName): void {
  const spec = SCHEMA[entity]
  const spelling = FEED_SPELLING[entity] ?? {}
  const editable: Readonly<Record<string, unknown>> =
    (FIELD_COVERAGE as Readonly<Record<string, Readonly<Record<string, unknown>>>>)[entity] ?? {}
  for (const field of Object.keys(spec.fields)) {
    if (field in prototype) {
      throw new Error(`[pool] ${entity}.${field} collides with a model member; rename one`)
    }
    const property = spelling[field] ?? field
    Object.defineProperty(prototype, field, {
      configurable: false,
      enumerable: false,
      get(this: EntityModel): unknown {
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

/**
 * THE issue: its row, its row view, its visibility, its roll-ups and its
 * edits. The groups (cached values) are `facts`, `rank`, `members`,
 * `presence`, `nesting`, `tip`, `attention`, `progress`, `loaded` and `view`.
 */
export class IssueModel extends EntityModel implements HeldIssue, IssueParts {
  constructor(id: string, host: ModelHost) {
    super('issue', id, host)
    makeObservable(this, {
      facts: computedStruct,
      rank: computedStruct,
      members: computedStruct,
      presence: computedStruct,
      nesting: computedStruct,
      tip: computedStruct,
      attention: computedStruct,
      progress: computedStruct,
      loaded: computedStruct,
      view: computedStruct,
      // Plain: the edit, and reads of the groups or parts run where read.
      update: false,
      standing: false,
      seatIds: false,
      laneMemberIds: false,
      memberIds: false,
      retainedSeatIds: false,
      rosterIds: false,
      retained: false,
      liveRoster: false,
      openOwn: false,
      flat: false,
      keeps: false,
      present: false,
      nestParent: false,
      placed: false,
      visible: false,
      ownAttention: false,
      aggregate: false,
      seatActivity: false,
      unitOwn: false,
      unitsBelow: false,
      label: false,
      displayRef: false,
      displayTitle: false,
      own: false,
      finished: false,
      formalParent: false,
      waiting: false,
      rollup: false,
      placement: false,
      ownFacts: false,
      childIds: false,
      spinOffIds: false,
      keptBelow: false,
      unread: false,
      repoTarget: false,
      prefix: false,
      originRef: false,
      originId: false,
      originTick: false,
      sessionIds: false,
      activityAt: false,
      loading: false,
    })
  }

  /** Edit this issue: one transaction of the write layer's log (paint, remember, send). */
  update(patch: EditPatch<'issue'>): TxId {
    return this.host.edit('issue', this.id, patch)
  }

  // ------------------------------------------------------------- the groups

  /** The own row, hot or cold, and the clock: standing, own part, settled placement. */
  get facts(): IssueFacts | undefined {
    return issueFactsPartOf(this.host.visibleInputs, this.id)
  }

  get rank(): RowRank | undefined {
    const part = this.facts?.part
    return part === undefined ? undefined : rankOfPart(this.id, part)
  }

  get members(): Members {
    return membersOf(this.host.visibleInputs, this.id, this.standing)
  }

  get presence(): Presence {
    return presenceOf(this.host.visibleInputs, this.id, this)
  }

  get nesting(): Nesting {
    return nestingOf(this.host.visibleInputs, this.id, this.standing, this.present)
  }

  get tip(): { readonly found: boolean; readonly pending: number } {
    return tipPartOf(this.host.rollupInputs, this.id)
  }

  get attention(): Attention {
    return attentionOf(this.host.rollupInputs, this.id, this)
  }

  get progress(): Progress {
    return progressOf(this.host.rollupInputs, this.id, this)
  }

  /**
   * What the IN-MEMORY row gives (one read of it, which queues a cold row's
   * load): its decision facts for the roll-up (`state` says whether it is in
   * memory) and its label for the view and a spin-off's origin tick. Cached,
   * so a view or a composition re-running reads no row.
   */
  get loaded(): { readonly facts: OwnFacts; readonly label: Label } {
    const row = this.host.rollupInputs.loadedIssue(this.id)
    return {
      facts: ownFactsOf(row),
      label: labelOfRow(this.host.inputs, this.id, row === LOADING ? undefined : row),
    }
  }

  /** The L1b row view; undefined while the row is not in memory (its load queued) or gone. */
  get view(): RowView | undefined {
    this.host.stats.rowsDerived += 1
    if (this.loaded.facts.state !== 'ready') return undefined
    return buildRowView(this.host.inputs, this.id, this)
  }

  // --------------------------------------------------- reads of the groups

  get standing(): Standing | undefined {
    return this.facts?.standing
  }

  get seatIds(): readonly string[] {
    return this.members.seatIds
  }

  get laneMemberIds(): readonly string[] {
    return this.members.laneMemberIds
  }

  get memberIds(): readonly string[] {
    return this.members.memberIds
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

  get keeps(): boolean {
    return this.presence.keeps
  }

  get present(): boolean {
    return this.presence.present
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

  get seatActivity(): number | null {
    return this.attention.seatActivity
  }

  get unitOwn(): UnitOwn {
    return this.progress.unitOwn
  }

  get unitsBelow(): Units {
    return this.progress.unitsBelow
  }

  get label(): Label {
    return this.loaded.label
  }

  get displayRef(): string | undefined {
    return this.label.displayRef
  }

  get displayTitle(): string | undefined {
    return this.label.displayTitle
  }

  /** The row view's own fields; undefined when the issue is unknown. */
  get own(): OwnPart | undefined {
    return this.facts?.part
  }

  // ------------------------------------ parts computed where they are read

  get finished(): boolean | undefined {
    return this.standing?.finished
  }

  get formalParent(): string | null {
    return formalParentPartOf(this)
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
    return keptBelowPartOf(this.host.visibleInputs, this.childIds)
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
    return originRefPartOf(this.host.inputs, this.id)
  }

  get originId(): string | null {
    return originIdPartOf(this.host.inputs, this.originRef)
  }

  get originTick(): RowOriginTick | null {
    return originTickPartOf(this.host.inputs, this.originId)
  }

  get sessionIds(): readonly string[] {
    return sessionIdsPartOf(this.host.inputs, this.id)
  }

  get activityAt(): number {
    return activityAtPartOf(this.host.inputs, this.id)
  }

  get loading(): boolean {
    return loadingPartOf(this.host.inputs, this.originRef, this.sessionIds)
  }
}

/** THE session: its row, and what its issues read of it. */
export class SessionModel extends EntityModel implements SessionVisibility {
  constructor(id: string, host: ModelHost) {
    super('session', id, host)
    makeObservable(this, {
      retention: computedStruct,
      activityMs: computed,
      links: computedStruct,
      verdict: computedStruct,
      issueLink: false,
      worktreeLink: false,
    })
  }

  /** Its part in its issue's visibility, hot or cold. */
  get retention(): Retention | null {
    return retentionOf(this.host.visibleInputs.sessionRow(this.id))
  }

  /** Its `lastActiveAt`, hot or cold: the unread rollup's and the row's activity stamp. */
  get activityMs(): number | null {
    return activityMsOf(this.host.visibleInputs.sessionRow(this.id))
  }

  get links(): SessionLinks {
    return sessionLinksOf(this.host.visibleInputs, this.id)
  }

  /** The seat's roll-up verdict, from the RESIDENT row; `LOADING` while it is cold. */
  get verdict(): Loaded<SeatVerdict> {
    return verdictPartOf(this.host.visibleInputs, this.id)
  }

  get issueLink(): string | null {
    return this.links.issueLink
  }

  get worktreeLink(): string | null {
    return this.links.worktreeLink
  }
}

export class WorktreeModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('worktree', id, host)
  }
}

export class RepoModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('repo', id, host)
  }
}

/** The issue's editable fields as setters take them (`issue.stage = 'review'`). */
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
  issue: IssueModel & Readonly<Omit<SliceIssue, 'unread' | 'title' | 'stage' | 'readAt'>> & IssueEdits
  session: SessionModel & Readonly<SliceSession>
  worktree: WorktreeModel & Readonly<Pick<SliceWorktree, 'path' | 'repoId' | 'repoPath'>>
  repo: RepoModel & Readonly<RepoRow> & { readonly path?: string }
}

/** The model class of each schema entity. */
export const MODEL_CLASSES: {
  readonly [E in EntityName]: new (
    id: string,
    host: ModelHost,
  ) => EntityModel
} = {
  issue: IssueModel,
  session: SessionModel,
  worktree: WorktreeModel,
  repo: RepoModel,
}

for (const entity of Object.keys(MODEL_CLASSES) as EntityName[]) {
  installFields(MODEL_CLASSES[entity].prototype, entity)
}
