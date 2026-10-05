import { isFinished, isClosed, isExcluded, issueAbandoned } from './predicates'
import { MISSION_VIEW_ISSUE_FIELDS, MISSION_VIEW_SESSION_FIELDS } from '../mission-view-schema'

/**
 * POD-4546 (L1a) — the ONE declared model schema both round-three substrates
 * build their pool-and-graph from.
 *
 * WHY THIS FILE EXISTS. Round two's audit found that every arm reinvented
 * relationship maintenance inside its own derivations, "where most of its bugs
 * and lines went, instead of one metadata-driven pool layer"
 * (`docs/decisions/4441-round-two-audit.md` §7). Linear declares relations once
 * as model metadata and the pool maintains both directions on every insert,
 * update and delete. This file is that metadata for Podium's worklist slice:
 * plain data, no classes, no decorators, no behaviour. The pool that reads it
 * is Ma2 (MobX) and Ha2 (hand-rolled); neither is implemented here.
 *
 * WHAT IS IN SCOPE. Entities, their fields with a citable source, and every
 * relation with its inverse and its residency (lazy) flag. The maintenance
 * rules the pool must implement are stated in
 * `docs/plans/pod-4545-round-three-schema.md` §4.
 *
 * WHAT IS NOT. Visibility, ordering, grouping, roll-ups and the row shape —
 * those are the row view contract (L1b) and the worklist phase. A rule that
 * reads more than one entity's fields is not a schema rule, with ONE declared
 * exception: the issue's residency (`cold: unlessShown`, POD-4665) reads its
 * member sessions (explicit ones, and since POD-4745 the issueless ones its
 * own checkout seats), because a row the list draws must be resident and the
 * sessions are what keep a closed issue drawn. It is an upper bound on
 * visibility, not visibility.
 *
 * SOURCES. Every field cites a zod schema in `@podium/model`, which is the
 * authoritative definition site [ADR 4], plus the replica collection the row
 * arrives on (`packages/client-core/src/replica/contract.ts` `ReplicaRows`) or
 * the engine seam that produces it. `schema.test.ts` resolves every citation
 * against the real zod shape at runtime, so a field that does not exist fails
 * the test rather than surviving as a comment.
 *
 * OWNERSHIP. `shared/` is owned by the round-two slice spec (POD-4442) and its
 * existing files are frozen. This file is ADDITIVE and owned by round three
 * (POD-4545); it neither imports nor modifies `slice-types.ts`.
 */

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * A zod schema in `@podium/model` that declares fields this schema cites.
 * `schema-sources.ts` maps each name to the real schema object; that map is
 * typed as total, so adding a name here without wiring it fails typecheck.
 */
import { ISSUE_PAGE_FIELDS, ISSUE_PAGE_SESSION_FIELDS } from '../issue-page-schema'

export type ModelSchemaName =
  | 'IssueProjection'
  | 'IssueUserStateWire'
  | 'IssueGitStateProjection'
  | 'IssueDerived'
  | 'IssueDepWire'
  | 'IssueDepProjection'
  | 'SessionMeta'
  | 'SessionUserStateWire'
  | 'AgentRuntimeState'
  | 'SessionOffer'
  | 'ResumeRef'
  | 'RepoProjection'
  | 'GitRepositoryWire'
  | 'GitWorktreeWire'
  | 'IssueGitState'

/**
 * Where a row physically arrives from.
 *
 * `replica:<kind>` is a collection of `ReplicaRows`
 * (`replica/contract.ts:92-145`); `schema-sources.ts` proves at typecheck time
 * that each `<kind>` is a real `ReplicaKind`. `engine:repos` is the machine's
 * repo scan (`EngineState.repos`, `GitRepositoryWire`), which is NOT a replica
 * collection — worktree lanes have no kind of their own and are built from it
 * (`shared/src/row-source.ts:308-323`).
 */
export type RowArrival =
  | 'replica:issueUserStates'
  | 'replica:issueGitStates'
  | 'replica:issueProjections'
  | 'replica:sessions'
  | 'replica:sessionUserStates'
  | 'replica:repos'
  | 'replica:issueDeps'
  | 'engine:repos'

/** Where one declared field's value comes from. */
export interface FieldSource {
  /** The model schema that declares it. */
  readonly schema: ModelSchemaName
  /** The property on that schema, when it is spelled differently here. */
  readonly property?: string
  /** The collection or seam the row carrying it arrives on. */
  readonly arrivesOn: RowArrival
}

/**
 * The field type vocabulary. Deliberately coarse: the pool needs to know what
 * can change identity (`id`), what is a timestamp the coarse clock compares
 * (`isoDate`) and what is an edge list it must walk (`depEdgeList`). Exact
 * value sets live in `@podium/model`.
 */
export type FieldType =
  | 'id'
  | 'string'
  | 'number'
  | 'boolean'
  | 'isoDate'
  | 'enum'
  | 'depEdgeList'
  | 'object'

/** A property of an object-typed field (`agentState.phase`, `offer.createdAt`). */
export interface PartSpec {
  readonly type: FieldType
  readonly optional?: boolean
  readonly nullable?: boolean
  readonly source: Omit<FieldSource, 'arrivesOn'>
  readonly why?: string
}

export interface FieldSpec {
  readonly type: FieldType
  /** The property may be absent. */
  readonly optional?: boolean
  /** The property may be `null`. */
  readonly nullable?: boolean
  /** For `enum`: the values this schema relies on. */
  readonly values?: readonly string[]
  /** For `object`: the properties this schema relies on. */
  readonly parts?: Readonly<Record<string, PartSpec>>
  readonly source: FieldSource
  readonly note?: string
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export type EntityName = 'issue' | 'session' | 'worktree' | 'repo'

/**
 * Four kinds, and no more.
 *
 * - `belongsTo` — a single reference this entity holds by a foreign key.
 * - `hasMany`   — a collection, defined as the INVERSE of a `belongsTo`,
 *                 `prefix` or outgoing `edge`. It has no key of its own; the
 *                 pool maintains it from the other side, which is why there is
 *                 exactly one maintenance path per edge.
 * - `prefix`    — a single reference resolved by longest-prefix path
 *                 containment, not by key equality. Its resolver is declared.
 * - `edge`      — a reference or collection carried by a declared edge list,
 *                 filtered by edge type. `direction: 'out'` reads this row's
 *                 list; `direction: 'in'` is the inverse side.
 */
export type RelationKind = 'belongsTo' | 'hasMany' | 'prefix' | 'edge'

/** A membership filter: rows failing it contribute NO edge. */
export interface RelationWhere {
  /** Fields the test reads. A change to any of them re-evaluates membership. */
  readonly fields: readonly string[]
  readonly test: (row: Readonly<Record<string, unknown>>) => boolean
  readonly why: string
}

interface RelationCommon {
  readonly to: EntityName
  /** The relation name on `to` that points back here. */
  readonly inverse: string
  /**
   * True when resolving this relation from a RESIDENT source instance may
   * require loading rows that are not resident. Derived by Rule L (see
   * {@link expectedLazy}); never hand-set.
   */
  readonly lazy: boolean
  /** One line: what this relation is for. */
  readonly why: string
  /** The frozen-slice relation this implements, when it is one of the four. */
  readonly slice?: 'R1' | 'R2' | 'R3' | 'R4'
  readonly where?: RelationWhere
  /** Raw membership counts retain resume twins; visible rosters still collapse. */
  readonly uncollapsed?: true
}

export interface BelongsToSpec extends RelationCommon {
  readonly kind: 'belongsTo'
  /** The field on THIS entity holding the reference. */
  readonly foreignKey: string
  /** The field on `to` the foreign key matches. */
  readonly targetKey: string
}

export interface HasManySpec extends RelationCommon {
  readonly kind: 'hasMany'
  /**
   * Named filtered views of this collection (POD-4758), maintained with it
   * by the pool: `subsets.issueless` on `worktree.sessions` holds the members
   * with no `issueId`. A member belongs to a subset while it is in the
   * collection AND passes the subset's test, so a reader lists it without
   * reading one member row to filter.
   */
  readonly subsets?: Readonly<Record<string, SubsetSpec>>
}

/**
 * A filtered view of a `hasMany` (POD-4758). The test reads the MEMBER's raw
 * row; `fields` are the member fields it reads, and a change to any of them
 * re-decides membership where the member sits.
 */
export interface SubsetSpec {
  readonly fields: readonly string[]
  readonly test: (member: Readonly<Record<string, unknown>>) => boolean
  readonly why: string
}

/**
 * Names a subset may not take: the members a navigation handle already
 * answers (`ready`, `loading`) and the id reads a typed link exposes (`ids`,
 * `size`).
 */
export const RESERVED_SUBSET_NAMES: ReadonlySet<string> = new Set(['ready', 'loading', 'ids', 'size'])

export interface PrefixSpec extends RelationCommon {
  readonly kind: 'prefix'
  /** The path-valued field on THIS entity being placed. */
  readonly sourceField: string
  /** The path-valued field on `to` that forms the root set. */
  readonly targetKey: string
  /** The resolver. Declared because a prefix relation is not a key join. */
  readonly resolver: 'longestPrefixPath'
  /**
   * Additional root sources beyond the target table's keys (POD-4671): every
   * distinct non-empty value of `entity[field]` is also a containment root.
   * The root set is the UNION of the target keys and every listed source, so
   * an issue's own `worktreePath` seats sessions even when no scan reported
   * that checkout (`session-ownership.ts:128-141`). Both pools' engines and
   * both from-scratch scans resolve the union from this declaration alone.
   */
  readonly alsoRoots?: readonly { readonly entity: EntityName; readonly field: string }[]
}

export interface EdgeSpec extends RelationCommon {
  readonly kind: 'edge'
  /** The edge-list field, on the OUT side's rows. */
  readonly edgeField: string
  /** The property of an edge naming the other endpoint. */
  readonly edgeIdKey: string
  /** The property of an edge carrying its type. */
  readonly edgeTypeKey: string
  /** Only edges of this type participate. */
  readonly edgeType: string
  /** Match every edge type (the page exposes custom relation types too). */
  readonly allTypes?: true
  /** Outgoing collections retain every target instead of the first match. */
  readonly many?: true
  /** `out`: read this row's list. `in`: the inverse side. */
  readonly direction: 'out' | 'in'
}

export type RelationSpec = BelongsToSpec | HasManySpec | PrefixSpec | EdgeSpec

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * A row stream composed into one entity instance, joined by the entity key.
 * The issue composite is the reason this exists: an issue is the wire row and
 * its normalized projection row, one instance, joined by `id`
 * (`replica/contract.ts:92-110`).
 */
export interface ComponentSpec {
  readonly schema: ModelSchemaName
  readonly arrivesOn: RowArrival
  /** The property on THIS component holding the entity key. */
  readonly joinKey: string
  /** Lower wins when two components carry the same field. */
  readonly precedence: number
  /**
   * Properties of this component's schema that are NOT composed onto the
   * instance, with the reason. The only case today is a nested row set the
   * feed explodes into rows of another entity; leaving it on the instance
   * would put a raw array where a maintained relation belongs — the exact
   * "pool without graph" shape the epic removes.
   */
  readonly notComposed?: Readonly<Record<string, string>>
  readonly why: string
}

/**
 * Whether instances of an entity can be absent from memory.
 *
 * Linear's partial bootstrap: cold collections stay on disk until touched and
 * objects become observable on first access (audit §7). `own` states the
 * predicate over the row itself; `via` says coldness is inherited through a
 * relation because the row alone cannot decide it.
 */
export type ColdSpec =
  | { readonly kind: 'never'; readonly why: string }
  | {
      readonly kind: 'own'
      /** Human-readable form of `predicate`, for the document and the panel. */
      readonly when: string
      /** Fields `predicate` reads; a change to any re-evaluates residency. */
      readonly dependsOn: readonly string[]
      readonly predicate: (row: Readonly<Record<string, unknown>>) => boolean
      readonly why: string
    }
  | {
      readonly kind: 'via'
      readonly relation: string
      /** Own decay when the raw reference is absent; a missing referenced row stays conservative. */
      readonly unbound?: {
        readonly dependsOn: readonly string[]
        readonly predicate: (row: Readonly<Record<string, unknown>>) => boolean
        readonly shownUntil: (row: Readonly<Record<string, unknown>>) => number
      }
      readonly why: string
    }
  | UnlessShownColdSpec

/**
 * POD-4665 — cold when `predicate` holds AND nothing the visible rule reads
 * can show the row: the row's own standing ({@link UnlessShownColdSpec.shownUntil})
 * and the members of each declared source ({@link KeptBySpec}) each say how
 * long they can show it, as a deadline on the slice clock (`coarseNow`,
 * inclusive: a deadline `t` shows the row while `coarseNow <= t`). The rule is
 * a SUPERSET of visibility, never a restatement of it: every deadline is the
 * latest instant its input could keep the row visible, so a row R-VIS shows is
 * never cold by rule, and a hidden row may be resident. Deadlines only pass,
 * so a row cold by rule at one clock stays cold by rule at every later one.
 */
export interface UnlessShownColdSpec {
  readonly kind: 'unlessShown'
  /** Human-readable form of the whole rule, for the document and the panel. */
  readonly when: string
  /** Own fields `predicate`, `shownUntil` and `finishOf` read. */
  readonly dependsOn: readonly string[]
  /** Whether the row may be cold at all. */
  readonly predicate: (row: Readonly<Record<string, unknown>>) => boolean
  /** Structural/placement bound, shared with member-triggered warming. */
  readonly canShow?: {
    /** Small summary kept for cold rows; never the full row. */
    readonly fields: readonly string[]
    /** Ancestor relation whose inverse must be revisited when an ancestor changes. */
    readonly through: string
    readonly test: (row: Readonly<Record<string, unknown>>, ctx: ColdContext) => boolean
  }
  /** The last instant the row can show on its own; `-Infinity` never, `Infinity` without limit. */
  readonly shownUntil: (row: Readonly<Record<string, unknown>>) => number
  /**
   * The instant a member's {@link MemberKeep} function decays from, or null
   * when it does not decay at all (read by the member side only).
   */
  readonly finishOf: (row: Readonly<Record<string, unknown>>) => number | null
  /** Every source of members that can keep the row shown; cold only when none can. */
  readonly keptBy: readonly KeptBySpec[]
  readonly why: string
}

/** One source of members that can keep an `unlessShown` row shown. */
export type KeptBySpec = MembersKeptBySpec | LaneKeptBySpec

/**
 * Members by reference: the rows of one `hasMany` (its inverse `belongsTo`,
 * by the RAW foreign key with the relation's `where` applied, before any
 * collapse) that can keep their row shown.
 */
export interface MembersKeptBySpec {
  readonly kind: 'members'
  /** A `hasMany` on the cold entity, the inverse of a `belongsTo`. */
  readonly relation: string
  /** Member fields `keep` reads. */
  readonly dependsOn: readonly string[]
  readonly keep: (member: Readonly<Record<string, unknown>>) => MemberKeep
  readonly why: string
}

/**
 * POD-4745 — members by containment (slice §2 R3): the rows a `prefix`
 * relation seats in the row's OWN lane that no explicit owner claims. The
 * row names its lane through `through` (a `belongsTo`, by its raw foreign
 * key); the lane's `relation` is a `hasMany` whose inverse is the `prefix`,
 * read as the relation holds it (the prefix's `where`, collapsed twins out,
 * the lane resolved over the union root set); a member counts only while it
 * is in the relation's declared `subset` (POD-4758: the issueless sessions,
 * the legacy test `issueId !== undefined`, `session-ownership.ts:152-158`).
 * Bounded by the lane's members: a row reads its own lane, never a scan.
 */
export interface LaneKeptBySpec {
  readonly kind: 'lane'
  /** A `belongsTo` on the cold entity naming its lane. */
  readonly through: string
  /** A `hasMany` on the lane whose inverse is a `prefix` on the member entity. */
  readonly relation: string
  /** A subset declared on `relation`: only its members are counted. */
  readonly subset: string
  /** Member fields `keep` reads. */
  readonly dependsOn: readonly string[]
  readonly keep: (member: Readonly<Record<string, unknown>>) => MemberKeep
  readonly why: string
}

/**
 * How long one member can keep its row shown: a deadline, or a function of
 * the row's {@link UnlessShownColdSpec.finishOf} (an idle session whose turn
 * finished decays from its issue's finish, `visibility.ts:51-58`).
 */
export type MemberKeep = number | ((finish: number) => number)

/**
 * A whole-kind membership rule: rows of one entity that share a group key
 * collapse to ONE kept row, and a collapsed row contributes NO edge to any of
 * its entity's relations — to every reader of the graph it is not there.
 *
 * Declared because the per-row feed cannot apply it (the rule reads a row's
 * siblings) and every pool must, identically. The decision itself is
 * {@link collapseLosers}, beside {@link longestPrefixPath}: the other declared
 * resolver. The only rule today is the session resume-twin collapse (POD-4553
 * addendum, POD-4566).
 */
export interface CollapseSpec {
  /** Fields the rule reads; a change to any re-evaluates the row's group. */
  readonly fields: readonly string[]
  /** The group a row belongs to, or null when the row never collapses. */
  readonly groupKey: (row: Readonly<Record<string, unknown>>) => string | null
  /** A group holding any row that passes this keeps EVERY row. */
  readonly keepsGroup: (row: Readonly<Record<string, unknown>>) => boolean
  /** Higher is kept. */
  readonly rank: (row: Readonly<Record<string, unknown>>) => number
  /** The field compared on a rank tie: the larger value is kept. */
  readonly recency: string
  /** A collapsed winner retains its earliest group's canonical ID position. */
  readonly order?: 'first-member'
  /** The legacy definition this re-expresses, cited. */
  readonly source: string
  readonly why: string
}

export interface EntitySpec {
  /** The identity field. */
  readonly key: string
  readonly components: Readonly<Record<string, ComponentSpec>>
  readonly fields: Readonly<Record<string, FieldSpec>>
  readonly relations: Readonly<Record<string, RelationSpec>>
  readonly cold: ColdSpec
  /** A whole-kind collapse rule over this entity's rows, when it has one. */
  readonly collapse?: CollapseSpec
  readonly why: string
}

export type ModelSchema = Readonly<Record<EntityName, EntitySpec>>

/**
 * Identity, typed. The schema is data; this only pins its shape, and keeps
 * its literal type (entity and relation names, each relation's kind, target
 * and laziness) for the typed navigation derived from it (`DeclaredSchema`,
 * POD-4758).
 */
function defineSchema<const S extends ModelSchema>(schema: S): S {
  return schema
}

// ---------------------------------------------------------------------------
// Declaration helpers
// ---------------------------------------------------------------------------

type Opts<T> = Omit<T, 'kind'>

// Each keeps its argument's literal type (`to`, `lazy`, `direction`,
// `subsets`): the typed navigation reads them (POD-4758).
const belongsTo = <const S extends Opts<BelongsToSpec>>(spec: S) => ({ kind: 'belongsTo' as const, ...spec })
const hasMany = <const S extends Opts<HasManySpec>>(spec: S) => ({ kind: 'hasMany' as const, ...spec })
const prefix = <const S extends Opts<PrefixSpec>>(spec: S) => ({ kind: 'prefix' as const, ...spec })
const edge = <const S extends Opts<EdgeSpec>>(spec: S) => ({ kind: 'edge' as const, ...spec })

// ---------------------------------------------------------------------------
// Reusable source shorthands
// ---------------------------------------------------------------------------

const derived = (property?: string): FieldSource => ({
  schema: 'IssueDerived',
  arrivesOn: 'replica:issueProjections',
  ...(property === undefined ? {} : { property }),
})
const projection = (property?: string): FieldSource => ({
  schema: 'IssueProjection',
  arrivesOn: 'replica:issueProjections',
  ...(property === undefined ? {} : { property }),
})
const sessionValue = (property: string): FieldSource => ({ schema: 'SessionUserStateWire', arrivesOn: 'replica:sessionUserStates', property })

const meta = (property?: string): FieldSource => ({
  schema: 'SessionMeta',
  arrivesOn: 'replica:sessions',
  ...(property === undefined ? {} : { property }),
})
const scan = (schema: 'GitRepositoryWire' | 'GitWorktreeWire', property?: string): FieldSource => ({
  schema,
  arrivesOn: 'engine:repos',
  ...(property === undefined ? {} : { property }),
})

// ---------------------------------------------------------------------------
// Session status vocabulary the resume-twin collapse reads
// (model/src/identity/session-identity.ts:45-72)
// ---------------------------------------------------------------------------

/** A group holding a row in one of these is kept in full. */
const ACTIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(['live', 'starting', 'reconnecting'])

/** Rank within a collapsing group; anything else (exited) ranks 0. */
const SESSION_STATUS_RANK: Readonly<Record<string, number>> = {
  live: 3,
  starting: 2,
  reconnecting: 2,
  hibernated: 1,
}

// ---------------------------------------------------------------------------
// The issue's residency bound (POD-4665)
// ---------------------------------------------------------------------------
//
// Upper bounds on R-VIS (slice spec §3; executable definition: the legacy
// `buildUnifiedRows`, `rows.ts:51-118`, with `sessionRetainsWorklistRow` and
// `issueVisibleInSidebar` from `slices/worklist/visibility.ts`). Each is the
// latest instant its input could keep the row visible. The inputs are every
// input R-VIS has: the issue's own standing, its unlanded branch
// (`awaitingMergeOf`, no decay), its explicit members (R2) and the
// issueless sessions its own checkout seats (R3, POD-4745). What is left out
// only makes a row resident that R-VIS hides: the rescue (a finished row is
// never rescued, `rows.ts:147`), nesting and placement (they only hide), the
// unread rollup (both decay windows are allowed), and resume-twin collapse
// for explicit members (every raw member counts). So the bound is complete:
// a row R-VIS shows at the pool's clock is never cold by rule. Only a clock
// rewind can show a cold row (the pool reads the highest clock it has seen).

/** `SIDEBAR_FINISHED_GRACE_MS` (`visibility.ts:18`). */
const FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** `SIDEBAR_FINISHED_UNREAD_WINDOW_MS` (`visibility.ts:22`). */
const FINISHED_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function epochMs(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

/** `visibility.ts:25-41` and `:51-69`: unread decays after 7 days, read after 24 h past the later of finish and read. */
function decayDeadline(finishMs: number, unread: boolean, readMs: number | null): number {
  if (unread || readMs === null) return finishMs + FINISHED_UNREAD_WINDOW_MS
  return Math.max(finishMs, readMs) + FINISHED_GRACE_MS
}

/** `rows.ts:62-69`: archived, deleted, `proposed`, or system-owned (`shipping`). */
export { isExcluded as issueExcluded } from './predicates'

/**
 * The most the merge verdict reads of an issue row: the finished and blocked
 * standing, the close reason (abandoned closures ask nothing), and the
 * checkout's merge axis. Structural so a frozen slice row (`SliceIssue`,
 * which does not spell `branch`/`gitState`) still answers it: the pool's
 * composed row carries the wire's fields at runtime
 * (`row-source.ts:84`, the wire cast).
 */
export interface MergeVerdictRow {
  readonly stage?: unknown
  readonly closedReason?: unknown
  readonly blocked?: unknown
  readonly branch?: unknown
  readonly gitState?: unknown
}

/**
 * `issuePendingDecision` (`slices/issues.ts:391-404`) without the review
 * fallback: a finished, non-abandoned issue whose private branch holds
 * unlanded work (`issueHasUnmergedDelivery`, `slices/issues.ts:357-367`).
 * R-VIS keeps such a row without limit (`rows.ts:95-104`,
 * `visibility.ts:31-32`), so the cold bound must too.
 */
export function awaitingMergeOf(row: MergeVerdictRow): boolean {
  const finished = isFinished(row)
  if (!finished) return false
  if (issueAbandoned(row)) return false
  return unmergedDeliveryOf(row)
}

/** Private unlanded commits, including a review-stage deliverable. */
export function unmergedDeliveryOf(row: MergeVerdictRow): boolean {
  const git = row.gitState as { shared?: unknown; merged?: unknown; ahead?: unknown } | null | undefined
  return (
    typeof row.branch === 'string' &&
    row.branch.length > 0 &&
    git != null &&
    git.shared === false &&
    git.merged !== true &&
    typeof git.ahead === 'number' &&
    git.ahead > 0
  )
}

/**
 * How long the issue can show without a session (`rows.ts:83-106`): an
 * active human issue and a closed top-level human issue without limit (the
 * closed fold does not decay, `visibility.ts:30`); a finished issue awaiting
 * merge without limit (unlanded commits stay unlanded, `visibility.ts:32`);
 * a finished human child inside `issueVisibleInSidebar`'s window, whichever
 * of the unread and read windows is later (the unread rollup reads sessions);
 * anything else never.
 */
function issueShownUntil(row: Readonly<Record<string, unknown>>): number {
  if (isExcluded(row)) return Number.NEGATIVE_INFINITY
  if (awaitingMergeOf(row)) return Number.POSITIVE_INFINITY
  const human = row['audience'] === 'human'
  const stage = row['stage']
  if (human && (stage === 'planning' || stage === 'in_progress' || stage === 'review')) {
    return Number.POSITIVE_INFINITY
  }
  if (!isFinished(row)) return Number.NEGATIVE_INFINITY
  if (!row['parentId']) {
    return human && isClosed(row)
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY
  }
  if (!human) return Number.NEGATIVE_INFINITY
  const finishMs = epochMs(row['closedAt'] ?? row['updatedAt'])
  const readMs = row['readAt'] ? epochMs(row['readAt']) : null
  return Math.max(decayDeadline(finishMs, true, null), decayDeadline(finishMs, false, readMs))
}

/** `issueFinishedAt` (`issues.ts:310`) when the issue is finished; an idle finished turn decays from it. */
function issueFinishOf(row: Readonly<Record<string, unknown>>): number | null {
  return isFinished(row) ? epochMs(row['closedAt'] ?? row['updatedAt']) : null
}

/**
 * Internal children only render under a placed, non-agent ancestor. An
 * excluded or cold human ancestor cannot be that row at this clock. Walk
 * the raw tree, as nesting does; an unknown ancestor remains conservative.
 * Parentless issues keep their started-by fallback and are not tightened.
 */
function issueCanShow(row: Readonly<Record<string, unknown>>, ctx: ColdContext): boolean {
  if (isExcluded(row)) return false
  if (row['audience'] !== 'agent' || !row['parentId'] || ctx.summary === undefined) return true
  const seen = new Set<string>()
  let parent: unknown = row['parentId']
  while (typeof parent === 'string' && parent.length > 0 && !seen.has(parent)) {
    seen.add(parent)
    const ancestor = ctx.summary('issue', parent)
    if (ancestor === undefined) return true
    // A parentless agent ancestor can itself be placed through its starter's
    // owner. Do not dismiss that fallback by looking only at the raw tree.
    if (!isExcluded(ancestor) &&
      (ancestor['audience'] !== 'agent' || (!ancestor['parentId'] && ancestor['startedBySession'])) &&
      !ctx.coldTarget('issue', parent)) return true
    parent = ancestor['parentId']
  }
  return false
}

/** The session fields {@link sessionKeep} reads. */
const SESSION_KEEP_FIELDS = ['archived', 'agentKind', 'stoppedAt', 'agentState', 'unread', 'readAt'] as const

/** What visibility reads of a cold session, without loading the full row. */
export const COLD_SESSION_FIELDS = [...SESSION_KEEP_FIELDS, 'issueId', 'status', 'lastActiveAt'] as const

/** The row-source's small ownership summary supplements the collapsed R2
 * roster. Headless seats never participate in resume collapse, including
 * exited seats; archived seats leave an otherwise empty draft unoccupied. */
export const ISSUE_SESSION_FACTS_SUMMARY = {
  field: 'sessionFacts',
  source: 'session',
  ownerKey: 'issueId',
  headlessOccupied: {
    fields: ['headless', 'archived'],
    test: (row: Readonly<Record<string, unknown>>) => row['headless'] === true && row['archived'] !== true,
    why: 'Draft occupancy uses non-archived attachments, regardless of status (isEmptyDraftVessel). R2 excludes headless seats.',
  },
} as const

/**
 * How long a session can keep its issue shown (`sessionRetainsWorklistRow`,
 * `visibility.ts:44-70`): a shell or an archived session never
 * (`isRowSeat`); a run that never finished without limit; a finished run
 * inside its decay window; an idle finished turn inside the window counted
 * from its issue's finish.
 */
function sessionKeep(row: Readonly<Record<string, unknown>>): MemberKeep {
  if (row['archived'] === true || row['agentKind'] === 'shell') return Number.NEGATIVE_INFINITY
  const state = row['agentState'] as
    | { phase?: unknown; since?: unknown; idle?: { kind?: unknown } }
    | undefined
  const phase = state?.phase
  const unread = row['unread'] === true
  const readMs = typeof row['readAt'] === 'string' && row['readAt'] ? epochMs(row['readAt']) : null
  const finishedRaw = row['stoppedAt'] ?? (phase === 'ended' ? state?.since : undefined)
  if (finishedRaw) return decayDeadline(epochMs(finishedRaw), unread, readMs)
  const idle = state?.idle?.kind
  if (phase === 'idle' && (idle === 'done' || idle === 'open_todos')) {
    return (finish) => decayDeadline(finish, unread, readMs)
  }
  return Number.POSITIVE_INFINITY
}

// ---------------------------------------------------------------------------
// THE SCHEMA
// ---------------------------------------------------------------------------

const DECLARED = defineSchema({
  /**
   * An issue: its normalized projection joined with personal markers, checkout
   * observations and repository facts at the row-source boundary.
   */
  issue: {
    key: 'id',
    why: 'The unit of work the worklist draws one row per.',
    components: {
      issueProjection: {
        schema: 'IssueProjection',
        arrivesOn: 'replica:issueProjections',
        joinKey: 'id',
        precedence: 0,
        why: 'The normalized durable row owns issue facts and keeps its asked, intentOrigin and isDraftVessel spellings.',
      },
    },
    fields: {
      ...MISSION_VIEW_ISSUE_FIELDS,
      id: { type: 'id', source: projection() },
      parentId: { type: 'id', optional: true, nullable: true, source: projection() },
      seq: { type: 'number', source: projection(), note: 'Immutable creation order key (slice §3 R-ORDER).' },
      createdAt: { type: 'isoDate', source: projection() },
      updatedAt: { type: 'isoDate', source: projection() },
      closedAt: { type: 'isoDate', optional: true, nullable: true, source: projection(), note: 'History candidate alongside archived and deleted; visibility keepers bound residency.' },
      deletedAt: { type: 'isoDate', optional: true, nullable: true, source: projection() },
      archived: { type: 'boolean', optional: true, source: projection() },
      stage: { type: 'string', source: projection(), note: 'Vocabulary in model/src/predicates/issue-stage.ts; the value set is a view rule (L1b), not a schema rule.' },
      closedReason: { type: 'string', optional: true, nullable: true, source: projection() },
      audience: { type: 'enum', values: ['human', 'agent'], optional: true, source: projection(), note: 'Who the issue is FOR (entities/issue.ts:289).' },
      isDraftVessel: { type: 'boolean', optional: true, source: projection('isDraftVessel') },
      pinned: { type: 'boolean', optional: true, source: { schema: 'IssueUserStateWire', arrivesOn: 'replica:issueUserStates' } },
      sortKey: { type: 'string', optional: true, nullable: true, source: projection() },
      deferUntil: { type: 'isoDate', optional: true, nullable: true, source: projection() },
      tuckedAt: { type: 'isoDate', optional: true, nullable: true, source: { schema: 'IssueUserStateWire', arrivesOn: 'replica:issueUserStates' } },
      repoId: { type: 'id', optional: true, nullable: true, source: projection(), note: 'Foreign key of the `repo` relation.' },
      repoPath: { type: 'string', source: { schema: 'RepoProjection', arrivesOn: 'replica:repos' }, note: 'Joined through the projection repoId; absent repository facts have not loaded yet.' },
      worktreePath: { type: 'string', optional: true, nullable: true, source: projection(), note: 'Foreign key of the `worktree` relation.' },
      branch: { type: 'string', optional: true, nullable: true, source: projection(), note: 'The private checkout branch; with an unlanded `gitState` it keeps a finished row shown (`awaitingMergeOf`).' },
      gitState: {
        type: 'object',
        optional: true,
        source: { ...derived(), arrivesOn: 'replica:issueGitStates' },
        note: 'The checkout observation comes from issueGitState and is composed without its issue id; absent observations remain unknown.',
        parts: {
          shared: { type: 'boolean', source: { schema: 'IssueGitState' }, why: 'True = multi-task checkout: the merge axis is suppressed.' },
          merged: { type: 'boolean', optional: true, source: { schema: 'IssueGitState' }, why: 'Authoritative landed verdict; absent when false.' },
          ahead: { type: 'number', optional: true, source: { schema: 'IssueGitState' }, why: 'Commits on branch not on the parent; absent when shared.' },
        },
      },
      coordinatorSessionId: { type: 'id', optional: true, nullable: true, source: projection() },
      startedBySession: { type: 'id', optional: true, nullable: true, source: projection(), note: 'Foreign key of the `startedBy` relation: the worklist nests a parentless issue under the one its starter session belongs to.' },
      deps: {
        type: 'depEdgeList',
        source: { schema: 'IssueDepProjection', property: 'toId', arrivesOn: 'replica:issueDeps' },
        note: 'The compatibility edge-list shape is composed from normalized issueDeps rows at the feed boundary. An edge change names its owner without requiring a companion wire update (POD-4953).',
        parts: {
          id: { type: 'id', source: { schema: 'IssueDepWire' }, why: 'The other endpoint.' },
          type: { type: 'string', source: { schema: 'IssueDepWire' }, why: 'The edge type; `discovered-from` is the only one in scope.' },
        },
      },
      needsHuman: { type: 'boolean', optional: true, source: projection() },
      blocked: { type: 'boolean', optional: true, source: derived(), note: 'The compatibility boolean is derived at the feed boundary from normalized edges and server-truth target stages, matching replica blocking (POD-4953).' },
      readAt: { type: 'isoDate', optional: true, nullable: true, source: { schema: 'IssueUserStateWire', arrivesOn: 'replica:issueUserStates' }, note: "The per-user cursor. `unread` is NOT a field: it is a rollup over this issue's sessions (issue-views.ts:391-410) and belongs to L1b." },
      title: { type: 'string', source: projection() },
      // The one open reference card, through the same normalized row reader.
      priority: { type: 'number', source: projection() },
      assignee: { type: 'id', optional: true, source: projection() },
      description: { type: 'object', source: projection(), note: 'The materialized document value is rendered by the reference card.' },
      activityNotes: { type: 'string', optional: true, source: projection() },
      notesUpdatedAt: { type: 'isoDate', optional: true, source: projection() },
      blockedByNotes: { type: 'object', source: projection() },
      panel: { type: 'object', optional: true, source: projection() },
      defaultAgent: { type: 'string', source: projection() },
      defaultModel: { type: 'string', source: projection() },
      defaultEffort: { type: 'string', source: projection() },
      machineId: { type: 'id', optional: true, source: projection() },
      ...ISSUE_PAGE_FIELDS,
    },
    relations: {
      parent: belongsTo({
        to: 'issue',
        foreignKey: 'parentId',
        targetKey: 'id',
        inverse: 'children',
        lazy: true,
        slice: 'R1',
        why: 'The formal issue tree; roll-ups walk it.',
        where: {
          fields: ['archived', 'deletedAt'],
          test: (row) => row['archived'] !== true && row['deletedAt'] == null,
          why: 'missionParentId (mission.ts:905-907): an archived or deleted issue contributes no edge. Its children surface as roots, never vanish.',
        },
      }),
      children: hasMany({
        to: 'issue',
        inverse: 'parent',
        lazy: true,
        slice: 'R1',
        why: 'The inverse collection the pool maintains; a child of a closed parent may be cold.',
      }),
      treeParent: belongsTo({
        to: 'issue',
        foreignKey: 'parentId',
        targetKey: 'id',
        inverse: 'treeChildren',
        lazy: true,
        why: "The raw parent edge, archived and deleted issues included: the worklist's nest walk follows `parentId` through ANY issue (nestStartedByIssues, rows.ts:271-283, walks allById), where `parent` drops an archived or deleted child's edge.",
      }),
      treeChildren: hasMany({
        to: 'issue',
        inverse: 'treeParent',
        lazy: true,
        why: 'Its inverse: a present row finds its nest children down it (a hidden child passes on the present rows below it).',
      }),
      startedBy: belongsTo({
        to: 'session',
        foreignKey: 'startedBySession',
        targetKey: 'sessionId',
        inverse: 'startedIssues',
        lazy: true,
        why: "The session that started this issue: the nest fallback for a parentless issue that is not a spin-off (nestStartedByIssues, rows.ts:288-305).",
      }),
      missionStartedBy: belongsTo({
        to: 'session',
        foreignKey: 'startedBySession',
        targetKey: 'sessionId',
        inverse: 'missionStartedIssues',
        lazy: true,
        why: 'Mission provenance, including archived/deleted candidates, while they have not left the originating mission.',
        where: {
          fields: ['stage', 'deps'],
          test: row => row['stage'] === 'proposed' || row['stage'] === 'backlog' ||
            (row['deps'] as readonly { id: string; type: string }[] | undefined)?.find(dep => dep.type === 'discovered-from')?.id == null,
          why: 'missionIssueIds / hasLeftMission: a started spin-off departs even when its origin row is absent.',
        },
      }),
      missionSessions: hasMany({
        to: 'session',
        inverse: 'missionIssue',
        lazy: true,
        why: 'Every explicit mission sender, including headless and archived sessions; never cwd-only seats.',
      }),
      sessions: hasMany({
        to: 'session',
        inverse: 'issue',
        lazy: true,
        slice: 'R2',
        why: 'Explicitly attached sessions. Precedence over prefix-owned ones is a view rule (L1b), not a schema rule.',
      }),
      discoveredFrom: edge({
        to: 'issue',
        edgeField: 'deps',
        edgeIdKey: 'id',
        edgeTypeKey: 'type',
        edgeType: 'discovered-from',
        direction: 'out',
        inverse: 'spinOffs',
        lazy: true,
        slice: 'R4',
        why: "The spin-off's origin (spinOffOriginId, mission.ts:479-483). NOT named `origin`: IssueProjection already has an `origin` field (entities/issue.ts:288).",
      }),
      spinOffs: edge({
        to: 'issue',
        edgeField: 'deps',
        edgeIdKey: 'id',
        edgeTypeKey: 'type',
        edgeType: 'discovered-from',
        direction: 'in',
        inverse: 'discoveredFrom',
        lazy: true,
        slice: 'R4',
        why: 'The inverse: issues discovered from this one.',
      }),
      pageDependencies: edge({
        to: 'issue', edgeField: 'deps', edgeIdKey: 'id', edgeTypeKey: 'type',
        edgeType: '*', allTypes: true, many: true, direction: 'out',
        inverse: 'pageDependents', lazy: true,
        why: 'Every dependency target, including multiple targets of a type and custom types.',
      }),
      pageDependents: edge({
        to: 'issue', edgeField: 'deps', edgeIdKey: 'id', edgeTypeKey: 'type',
        edgeType: '*', allTypes: true, many: true, direction: 'in',
        inverse: 'pageDependencies', lazy: true,
        why: 'Every dependency source; edge types and order are read from its declared edge list.',
      }),
      bornSessions: hasMany({
        to: 'session', inverse: 'bornIssue', lazy: true,
        why: 'Forwarding ghosts: sessions born here which now work on another issue.',
      }),
      pageSessions: hasMany({
        to: 'session', inverse: 'pageIssue', lazy: true,
        why: 'Raw non-shell attachment IDs used by page counts and destructive-action prompts.',
      }),
      supersedingIssue: belongsTo({
        to: 'issue', foreignKey: 'supersededBy', targetKey: 'id', inverse: 'supersededIssues', lazy: true,
        why: 'The issue page resolves the successor of a superseded task.',
      }),
      supersededIssues: hasMany({ to: 'issue', inverse: 'supersedingIssue', lazy: true, why: 'Inverse successor references.' }),
      canonicalIssue: belongsTo({
        to: 'issue', foreignKey: 'duplicateOf', targetKey: 'id', inverse: 'duplicateIssues', lazy: true,
        why: 'The issue page resolves the canonical task of a duplicate.',
      }),
      duplicateIssues: hasMany({ to: 'issue', inverse: 'canonicalIssue', lazy: true, why: 'Inverse duplicate references.' }),
      worktree: belongsTo({
        to: 'worktree',
        foreignKey: 'worktreePath',
        targetKey: 'path',
        inverse: 'issues',
        lazy: false,
        why: "The issue's checkout. The containment root prefix-owned sessions resolve to (slice §2 R3).",
      }),
      repo: belongsTo({
        to: 'repo',
        foreignKey: 'repoId',
        targetKey: 'id',
        inverse: 'issues',
        lazy: false,
        why: 'Replaces the denormalized `issue.prefix`: `displayRef` reads `issue.repo.prefix` (replica/contract.ts:106-110).',
      }),
    },
    cold: {
      kind: 'unlessShown',
      when: 'archived, deleted, or closed, and structurally unable to show or past every own/member/lane keeper at the current clock',
      dependsOn: [
        'closedAt',
        'archived',
        'deletedAt',
        'stage',
        'closedReason',
        'blocked',
        'audience',
        'parentId',
        'startedBySession',
        'worktreePath',
        'readAt',
        'updatedAt',
        'branch',
        'gitState',
      ],
      predicate: (row) => row['closedAt'] != null || row['archived'] === true || row['deletedAt'] != null,
      canShow: {
        fields: ['parentId', 'audience', 'archived', 'deletedAt', 'stage', 'startedBySession', 'worktreePath'],
        through: 'treeParent',
        test: issueCanShow,
      },
      shownUntil: issueShownUntil,
      finishOf: issueFinishOf,
      keptBy: [
        {
          kind: 'members',
          relation: 'sessions',
          dependsOn: SESSION_KEEP_FIELDS,
          keep: sessionKeep,
          why: 'A retained session keeps a closed issue in the list (R-VIS 2); 294 of the 376 closed rows visible at 1x are there for one.',
        },
        {
          kind: 'lane',
          through: 'worktree',
          relation: 'sessions',
          subset: 'issueless',
          dependsOn: SESSION_KEEP_FIELDS,
          keep: sessionKeep,
          why: "R3 (POD-4745): an issueless session running in the issue's own checkout is one of its seats by containment (`indexSessionOwnership`, session-ownership.ts:152-158), and a retained seat keeps the row shown exactly as an explicit member does. Without it the bound held only on today's data (no closed row at 1x or 4x is kept by such a session alone), and an arm had to evaluate every cold row at bootstrap to be safe.",
        },
      ],
      why: 'History stays out of observable tables unless R-VIS can show it: closed folds, completion windows, merge work and retained sessions. Archived/deleted rows and internal children with no potential nesting path cannot show, whatever a session keeps. A parentless ancestor may use its started-by fallback; a live descendant loads an unplaced parent only when its compact keeper bound can give pre-nesting presence. A clock rewind remains the loading exception.',
    },
  },

  /** One session (slice §1). */
  session: {
    key: 'sessionId',
    why: 'An agent or shell at work; what makes an issue look alive.',
    components: {
      session: {
        schema: 'SessionMeta',
        arrivesOn: 'replica:sessions',
        joinKey: 'sessionId',
        precedence: 0,
        why: 'One row, one component — sessions are not split across a wire and a projection.',
      },
    },
    fields: {
      ...MISSION_VIEW_SESSION_FIELDS,
      sessionId: { type: 'id', source: meta() },
      issueId: { type: 'id', optional: true, nullable: true, source: meta(), note: 'Foreign key of the `issue` relation.' },
      cwd: { type: 'string', source: meta(), note: "The path the `worktree` prefix relation places. There is no `session.worktreePath`." },
      agentKind: { type: 'string', optional: true, nullable: true, source: meta() },
      headless: { type: 'boolean', optional: true, source: meta(), note: 'Structural membership filter on both session relations.' },
      status: { type: 'string', optional: true, nullable: true, source: meta() },
      archived: { type: 'boolean', optional: true, source: meta(), note: 'Read-side filter (L1b), NOT a membership filter: the unread rollup must see the same seats (arms/hand/indexes.ts:26).' },
      lastActiveAt: { type: 'isoDate', source: meta() },
      stoppedAt: { type: 'isoDate', optional: true, nullable: true, source: meta() },
      readAt: { type: 'isoDate', optional: true, nullable: true, source: sessionValue('readAt') },
      unread: { type: 'boolean', optional: true, source: sessionValue('readAt'), note: 'Derived from the personal read cursor and session activity at the row-source boundary; legacy only while the companion is absent.' },
      agentState: {
        type: 'object',
        optional: true,
        source: meta(),
        parts: {
          phase: { type: 'string', optional: true, nullable: true, source: { schema: 'AgentRuntimeState' }, why: 'Row motion phase (slice §3 R-SUM).' },
          since: { type: 'isoDate', optional: true, source: { schema: 'AgentRuntimeState' }, why: 'Timing anchor.' },
          workingMsTotal: { type: 'number', optional: true, source: { schema: 'AgentRuntimeState' }, why: 'Timer base.' },
        },
      },
      offer: {
        type: 'object',
        optional: true,
        nullable: true,
        source: meta(),
        parts: {
          createdAt: { type: 'isoDate', optional: true, source: { schema: 'SessionOffer' }, why: 'Waiting-age anchor; the only property of the offer in scope.' },
        },
      },
      resume: {
        type: 'object',
        optional: true,
        source: meta(),
        note: "Resume twins: sessions sharing a ref collapse to one unless any is live/starting/reconnecting. The pool's declared session.collapse keeps the survivor consistent across per-row readers (POD-4566).",
        parts: {
          kind: { type: 'string', source: { schema: 'ResumeRef' }, why: 'Half of the twin key.' },
          value: { type: 'string', source: { schema: 'ResumeRef' }, why: 'Half of the twin key.' },
        },
      },
      refIssueId: { type: 'id', optional: true, source: meta() },
      ...ISSUE_PAGE_SESSION_FIELDS,
    },
    relations: {
      bornIssue: belongsTo({
        to: 'issue', foreignKey: 'refIssueId', targetKey: 'id',
        inverse: 'bornSessions', lazy: true,
        why: 'The permanent creation issue, independent of the current attachment.',
      }),
      pageIssue: belongsTo({
        to: 'issue', foreignKey: 'issueId', targetKey: 'id',
        inverse: 'pageSessions', lazy: true, uncollapsed: true,
        where: { fields: ['agentKind'], test: row => row['agentKind'] !== 'shell',
          why: 'Replica issue membership includes raw headless/archived/resume-twin rows, excluding shells.' },
        why: 'The replica page membership contract before visual resume collapse.',
      }),
      startedIssues: hasMany({
        to: 'issue',
        inverse: 'startedBy',
        lazy: true,
        why: "The issues this session started: a present issue finds the ones its sessions started, nested under it by the started-by fallback.",
      }),
      missionStartedIssues: hasMany({
        to: 'issue',
        inverse: 'missionStartedBy',
        lazy: true,
        why: 'Eligible mission provenance candidates, maintained from the declared starter edge.',
      }),
      missionIssue: belongsTo({
        to: 'issue',
        foreignKey: 'issueId',
        targetKey: 'id',
        inverse: 'missionSessions',
        lazy: true,
        why: 'missionSessionIndex uses explicit issueId ownership, including headless and archived sessions.',
      }),
      issue: belongsTo({
        to: 'issue',
        foreignKey: 'issueId',
        targetKey: 'id',
        inverse: 'sessions',
        lazy: true,
        slice: 'R2',
        why: 'Explicit membership.',
        where: {
          fields: ['headless'],
          test: (row) => row['headless'] !== true,
          why: 'A headless session is never a member (slice §2 R2).',
        },
      }),
      worktree: prefix({
        to: 'worktree',
        sourceField: 'cwd',
        targetKey: 'path',
        resolver: 'longestPrefixPath',
        inverse: 'sessions',
        lazy: false,
        slice: 'R3',
        why: 'Containment ownership: a session whose cwd sits under a checkout belongs to it and never renders orphaned (session-ownership.ts:161-164). The root set is the scanned lanes PLUS every issue\u2019s own worktreePath (session-ownership.ts:128-141), so an unscanned checkout still seats its sessions.',
        alsoRoots: [{ entity: 'issue', field: 'worktreePath' }],
        where: {
          fields: ['headless'],
          test: (row) => row['headless'] !== true,
          why: 'A headless session is never a member (slice §2 R3).',
        },
      }),
    },
    collapse: {
      fields: ['resume', 'headless', 'status', 'lastActiveAt'],
      groupKey: (row) => {
        const resume = row['resume'] as { kind?: unknown; value?: unknown } | undefined | null
        if (row['headless'] === true || resume == null) return null
        return typeof resume.kind === 'string' && typeof resume.value === 'string'
          ? `${resume.kind}\u0000${resume.value}`
          : null
      },
      keepsGroup: (row) => ACTIVE_SESSION_STATUSES.has(row['status'] as string),
      rank: (row) => SESSION_STATUS_RANK[row['status'] as string] ?? 0,
      recency: 'lastActiveAt',
      order: 'first-member',
      source:
        'dedupeSessionsByResume (model/src/identity/session-identity.ts), preserved by the pool resumeGroup collapse rule.',
      why: "Resume twins: session rows pointing at the SAME agent conversation collapse to the most useful one (live > starting/reconnecting > hibernated > exited, then the most recently active), EXCEPT that a group holding an active row is kept in full. A headless row never takes part: it shares its terminal twin's ref by design. On an exact tie of rank and recency the legacy keeps the row earlier in the runtime's list, an order a pool does not have; the lower session id is kept instead.",
    },
    cold: {
      kind: 'via',
      relation: 'issue',
      unbound: {
        dependsOn: ['issueId', ...SESSION_KEEP_FIELDS],
        predicate: (row) => row['stoppedAt'] != null || (row['agentState'] as { phase?: unknown } | undefined)?.phase === 'ended',
        shownUntil: (row) => keepDeadline(sessionKeep(row), null),
      },
      why: 'A bound session inherits its issue’s residency. An unbound stopped run is cold after the same acknowledgment/decay window its issue keeper uses.',
    },
  },

  /**
   * A checkout lane. Not rendered (slice §6); it exists so R3 has a root set
   * and so repo facts are reached through the graph rather than copied onto
   * every issue.
   */
  worktree: {
    key: 'path',
    why: 'The containment root longest-prefix session ownership resolves against.',
    components: {
      worktree: {
        schema: 'GitWorktreeWire',
        arrivesOn: 'engine:repos',
        joinKey: 'path',
        precedence: 0,
        why: 'One lane per scanned worktree (GitRepositoryWire.worktrees[], row-source.ts:319-321).',
      },
      repoRoot: {
        schema: 'GitRepositoryWire',
        arrivesOn: 'engine:repos',
        joinKey: 'path',
        precedence: 1,
        why: 'A repo root is itself a lane (row-source.ts:318) and stamps repoId/repoPath onto the worktrees it contains.',
      },
    },
    fields: {
      path: { type: 'string', source: scan('GitWorktreeWire'), note: 'For a repo-root lane the value is GitRepositoryWire.path.' },
      repoId: { type: 'id', optional: true, nullable: true, source: scan('GitRepositoryWire'), note: 'Stamped from the CONTAINING scan row (row-source.ts:313-321); foreign key of the `repo` relation.' },
      repoPath: { type: 'string', source: scan('GitRepositoryWire', 'path'), note: 'The containing scan row’s path — the lane’s repo identity when repoId is absent.' },
    },
    relations: {
      sessions: hasMany({
        to: 'session',
        inverse: 'worktree',
        lazy: true,
        slice: 'R3',
        why: 'The prefix relation’s inverse collection; may hold sessions of closed issues.',
        subsets: {
          issueless: {
            fields: ['issueId'],
            test: (row: Readonly<Record<string, unknown>>) => row['issueId'] === undefined,
            why: "The lane's sessions no explicit owner claims (`indexSessionOwnership`, session-ownership.ts:152-158: the legacy tests `issueId !== undefined`, so an explicit null still claims). They seat by containment under the issues checked out here (R3), and keep a closed one of them shown (`issue.cold.keptBy`, POD-4745).",
          },
        },
      }),
      issues: hasMany({
        to: 'issue',
        inverse: 'worktree',
        lazy: true,
        why: 'Issues checked out here. Composing it with `sessions` is how an issue reaches its prefix-owned sessions.',
      }),
      repo: belongsTo({
        to: 'repo',
        foreignKey: 'repoId',
        targetKey: 'id',
        inverse: 'worktrees',
        lazy: false,
        why: 'The lane’s repo, for the group key, label and prefix.',
      }),
    },
    cold: { kind: 'never', why: 'One row per checkout on the machine: tens, not thousands. Always resident.' },
  },

  /**
   * A logical repo: the replicated `(id, prefix)` row joined with the
   * machine's scan row for its path.
   */
  repo: {
    key: 'id',
    why: 'Supplies the group key, the group label and the `displayRef` prefix, once, instead of on every issue.',
    components: {
      repo: {
        schema: 'RepoProjection',
        arrivesOn: 'replica:repos',
        joinKey: 'id',
        precedence: 0,
        why: 'The replicated row [POD-822]: a prefix change moves every POD-13 in the repo without rewriting an issue (replica/contract.ts:106-110).',
      },
      repoScan: {
        schema: 'GitRepositoryWire',
        arrivesOn: 'engine:repos',
        joinKey: 'repoId',
        precedence: 1,
        notComposed: {
          worktrees:
            'The nested lanes. The feed explodes this array into `worktree` rows (row-source.ts:319-321); the repo instance reaches them through the maintained `worktrees` relation, never as a raw array.',
        },
        why: 'The machine’s scan row, joined id ↔ repoId; it is where the path (and so the label) comes from.',
      },
    },
    fields: {
      id: { type: 'id', source: { schema: 'RepoProjection', arrivesOn: 'replica:repos' } },
      prefix: { type: 'string', optional: true, nullable: true, source: { schema: 'RepoProjection', arrivesOn: 'replica:repos' }, note: 'Absent renders `#seq` (slice §3 R-SUM).' },
      path: { type: 'string', source: scan('GitRepositoryWire'), note: 'The repo label is derived from this at view time (L1b), never stored.' },
    },
    relations: {
      issues: hasMany({ to: 'issue', inverse: 'repo', lazy: true, why: 'Every issue in the repo; holds closed ones.' }),
      worktrees: hasMany({ to: 'worktree', inverse: 'repo', lazy: false, why: 'The repo’s lanes.' }),
    },
    cold: { kind: 'never', why: 'One row per repo: a handful. Always resident.' },
  },
})

/** The schema, as every engine reads it: data, keyed by name. */
export const SCHEMA: ModelSchema = DECLARED

/**
 * The schema's literal type (POD-4758): what the typed relation navigation
 * derives its names, targets, kinds and laziness from, so a misspelled
 * relation does not compile (`shared/src/links.ts`).
 */
export type DeclaredSchema = typeof DECLARED

// ---------------------------------------------------------------------------
// Rule L — lazy is derived, never hand-set
// ---------------------------------------------------------------------------

/**
 * A relation is lazy iff its TARGET entity can be non-resident.
 *
 * "Lazy" is about RESIDENCY, not about the cold predicate: a closed issue that
 * has been touched is resident, but its sessions need not be, so reading
 * `issue.sessions` can still require a load. Callers of a lazy relation must
 * handle the unhydrated state (audit §7: "type-level marking of unhydrated
 * relations"); callers of a non-lazy one never see it.
 *
 * `schema.test.ts` recomputes every declared flag from this function, so a
 * hand-edited flag fails the test.
 */
export function expectedLazy(schema: ModelSchema, relation: RelationSpec): boolean {
  return schema[relation.to].cold.kind !== 'never'
}

/**
 * The row a `via` entity inherits residency from (its `cold.relation`'s
 * RAW foreign key: residency follows the reference, not the relation's
 * `where`, so a headless session of a closed issue is cold too), or null.
 */
export function viaTargetOf(
  schema: ModelSchema,
  entity: EntityName,
  row: object,
): { readonly to: EntityName; readonly id: string } | null {
  const spec = schema[entity].cold
  if (spec.kind !== 'via') return null
  const relation = schema[entity].relations[spec.relation]
  if (relation?.kind !== 'belongsTo') {
    throw new Error(`[schema] ${entity}.cold.via must name a belongsTo (got ${relation?.kind})`)
  }
  const key = (row as Readonly<Record<string, unknown>>)[relation.foreignKey]
  return typeof key === 'string' && key.length > 0 ? { to: relation.to, id: key } : null
}

/**
 * What {@link coldByRule} asks of its caller. A pool answers from what it
 * holds; a rebuild, a re-partition and the gate's check answer from whole
 * row tables ({@link tableColdContext}).
 */
export interface ColdContext {
  /** The slice clock (`coarseNow`, epoch ms) `unlessShown` deadlines are read against. */
  readonly now: number
  /** Whether `to:id` is known and cold by rule (a `via` row's target). */
  coldTarget(to: EntityName, id: string): boolean
  /** Only the entity's declared canShow summary, from resident input or a cold summary. */
  summary?(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined
  /**
   * The keeps of the members one `source` of an `unlessShown` entity's
   * `keptBy` holds at `key` ({@link keptByKey}): for `members`, every member
   * row naming the row by the raw foreign key with the relation's `where`
   * passed ({@link keeperOf}); for `lane`, every unowned member the lane
   * named `key` seats ({@link laneKeepOf}).
   */
  keeps(entity: EntityName, source: KeptBySpec, key: string): Iterable<MemberKeep>
}

/**
 * Whether `row` of `entity` may stay out of memory, by `schema[entity].cold`:
 * `never` is always resident, `own` is the entity's predicate over its row,
 * `via` is cold when the row it inherits from ({@link viaTargetOf}) is known
 * and cold by rule, which `ctx.coldTarget` answers; `unlessShown` is cold when
 * its predicate holds and every deadline, its own and each member's of every
 * source, has passed at `ctx.now` (POD-4665, POD-4745). POD-4580 (Ha3) shares
 * it so a pool, its rebuild and the gate's partition check apply one rule;
 * both arms import it (the MobX arm since POD-4568 G2).
 */
export function coldByRule(
  schema: ModelSchema,
  entity: EntityName,
  row: object,
  ctx: ColdContext,
): boolean {
  const spec = schema[entity].cold
  const fields = row as Readonly<Record<string, unknown>>
  if (spec.kind === 'never') return false
  if (spec.kind === 'own') return spec.predicate(fields)
  if (spec.kind === 'unlessShown') {
    if (!spec.predicate(fields)) return false
    if (spec.canShow !== undefined && !spec.canShow.test(fields, ctx)) return true
    if (ctx.now <= spec.shownUntil(fields)) return false
    const finish = spec.finishOf(fields)
    for (const source of spec.keptBy) {
      const key = keptByKey(schema, entity, fields, source)
      if (key === null) continue
      for (const keep of ctx.keeps(entity, source, key)) {
        if (ctx.now <= keepDeadline(keep, finish)) return false
      }
    }
    return true
  }
  const target = viaTargetOf(schema, entity, row)
  return target === null
    ? spec.unbound !== undefined && spec.unbound.predicate(fields) && ctx.now > spec.unbound.shownUntil(fields)
    : ctx.coldTarget(target.to, target.id)
}

/** A member's deadline given its row's `finishOf` (null: an idle finished turn never decays). */
export function keepDeadline(keep: MemberKeep, finish: number | null): number {
  if (typeof keep === 'number') return keep
  return finish === null ? Number.POSITIVE_INFINITY : keep(finish)
}

/**
 * The pre-nesting presence bound in a cold issue's declared summary. Reuses
 * its compact own/finish deadlines and existing keeper indexes; no row read.
 * A placement-cold issue with a live descendant needs a load only while
 * this bound could still give it a row before nesting.
 */
export function coldFlatUntil(
  schema: ModelSchema,
  entity: EntityName,
  id: string,
  summary: Readonly<Record<string, unknown>>,
  bound: { readonly finish: number | null; readonly shownUntil: number },
  ctx: ColdContext,
): number {
  const spec = schema[entity].cold
  if (spec.kind !== 'unlessShown') return Number.NEGATIVE_INFINITY
  let until = bound.shownUntil
  for (const source of spec.keptBy) {
    const key = keptByKey(schema, entity, { ...summary, [schema[entity].key]: id }, source)
    if (key === null) continue
    for (const keep of ctx.keeps(entity, source, key)) until = Math.max(until, keepDeadline(keep, bound.finish))
  }
  return until
}

/**
 * Where `source` holds the members of `row` of the `unlessShown` entity
 * `entity`: its own key for `members`; the raw foreign key of `through` (its
 * lane) for `lane`. Null when the row has none.
 */
export function keptByKey(
  schema: ModelSchema,
  entity: EntityName,
  row: object,
  source: KeptBySpec,
): string | null {
  const fields = row as Readonly<Record<string, unknown>>
  const field =
    source.kind === 'members'
      ? schema[entity].key
      : laneOf(schema, entity, source).through.foreignKey
  const key = fields[field]
  return typeof key === 'string' && key.length > 0 ? key : null
}

/** A `members` source, resolved: the member entity and the `belongsTo` naming the owner. */
interface MembersLink {
  readonly source: MembersKeptBySpec
  readonly member: EntityName
  readonly link: BelongsToSpec
}

/** The `members` sources of `entity`'s `keptBy`, resolved (throws on a malformed one). */
function membersLinks(schema: ModelSchema, entity: EntityName): MembersLink[] {
  const spec = schema[entity].cold
  if (spec.kind !== 'unlessShown') return []
  const out: MembersLink[] = []
  for (const source of spec.keptBy) {
    if (source.kind !== 'members') continue
    const relation = schema[entity].relations[source.relation]
    if (relation?.kind !== 'hasMany') {
      throw new Error(`[schema] ${entity}.cold.keptBy must name a hasMany (got ${relation?.kind})`)
    }
    const link = schema[relation.to].relations[relation.inverse]
    if (link?.kind !== 'belongsTo') {
      throw new Error(`[schema] ${entity}.cold.keptBy's inverse must be a belongsTo (got ${link?.kind})`)
    }
    out.push({ source, member: relation.to, link })
  }
  return out
}

/**
 * A `lane` source of an `unlessShown` entity, resolved against the schema
 * (POD-4745). For the issue: `issue.worktree` → `worktree.sessions` (the
 * inverse of the `session.worktree` prefix), unowned by `session.issue`, and
 * the owners a member at a lane can keep are `worktree.issues`.
 */
export interface LaneSource {
  readonly owner: EntityName
  readonly source: LaneKeptBySpec
  /** The owner's `belongsTo` naming its lane (`issue.worktree`). */
  readonly through: BelongsToSpec
  /** The lane entity (`worktree`). */
  readonly lane: EntityName
  /** The lane's collection of owners, `through`'s inverse (`issues`). */
  readonly owners: string
  /** The lane's collection the members sit in (`sessions`). */
  readonly relation: string
  /** The member entity (`session`). */
  readonly member: EntityName
  /** The member's `prefix` relation name and spec (`session.worktree`). */
  readonly prefixName: string
  readonly prefix: PrefixSpec
  /** The subset of `relation` whose members count (`issueless`), and its declaration. */
  readonly subsetName: string
  readonly subset: SubsetSpec
}

/** A `lane` source's resolution, or the reason it does not resolve. */
function resolveLane(
  schema: ModelSchema,
  owner: EntityName,
  source: LaneKeptBySpec,
): LaneSource | string {
  const through = schema[owner].relations[source.through]
  if (through?.kind !== 'belongsTo') return `through "${source.through}" must name a belongsTo`
  const lane = through.to
  const relation = schema[lane].relations[source.relation]
  if (relation?.kind !== 'hasMany') {
    return `relation "${lane}.${source.relation}" must name a hasMany`
  }
  const prefix = schema[relation.to].relations[relation.inverse]
  if (prefix?.kind !== 'prefix') {
    return `"${lane}.${source.relation}"'s inverse must be a prefix (got ${prefix?.kind})`
  }
  const subset = relation.subsets?.[source.subset]
  if (subset === undefined) {
    return `subset "${source.subset}" is not declared on ${lane}.${source.relation}`
  }
  return {
    owner,
    source,
    through,
    lane,
    owners: through.inverse,
    relation: source.relation,
    member: relation.to,
    prefixName: relation.inverse,
    prefix,
    subsetName: source.subset,
    subset,
  }
}

function laneOf(schema: ModelSchema, owner: EntityName, source: LaneKeptBySpec): LaneSource {
  const found = resolveLane(schema, owner, source)
  if (typeof found === 'string') throw new Error(`[schema] ${owner}.cold.keptBy (lane): ${found}`)
  return found
}

/** Every `lane` source in the schema, resolved (throws on a malformed one). */
export function laneSources(schema: ModelSchema): readonly LaneSource[] {
  const out: LaneSource[] = []
  for (const owner of Object.keys(schema) as EntityName[]) {
    const spec = schema[owner].cold
    if (spec.kind !== 'unlessShown') continue
    for (const source of spec.keptBy) {
      if (source.kind === 'lane') out.push(laneOf(schema, owner, source))
    }
  }
  return out
}

/** The entities whose rows can keep an `unlessShown` row of another entity resident. */
export function keeperEntities(schema: ModelSchema): ReadonlySet<EntityName> {
  const out = new Set<EntityName>()
  for (const entity of Object.keys(schema) as EntityName[]) {
    for (const found of membersLinks(schema, entity)) out.add(found.member)
  }
  for (const lane of laneSources(schema)) out.add(lane.member)
  return out
}

/**
 * The row `row` of `entity` can keep resident through a `members` source,
 * and how long ({@link MembersKeptBySpec}): by the RAW foreign key of the
 * relation's inverse, with that relation's `where` applied (a headless
 * session keeps nothing), before any collapse; null when it names nothing.
 */
export function keeperOf(
  schema: ModelSchema,
  entity: EntityName,
  row: object,
): {
  readonly to: EntityName
  readonly id: string
  readonly source: MembersKeptBySpec
  readonly keep: MemberKeep
} | null {
  const fields = row as Readonly<Record<string, unknown>>
  for (const owner of Object.keys(schema) as EntityName[]) {
    for (const found of membersLinks(schema, owner)) {
      if (found.member !== entity) continue
      if (found.link.where !== undefined && !found.link.where.test(fields)) return null
      const key = fields[found.link.foreignKey]
      if (typeof key !== 'string' || key.length === 0) return null
      return { to: owner, id: key, source: found.source, keep: found.source.keep(fields) }
    }
  }
  return null
}

/**
 * How long `row` of `lane.member` can keep, through `lane`, the owners of
 * whatever lane seats it (POD-4745): its keep while it passes the lane's
 * declared subset (POD-4758), else null. Which lane seats it (the prefix's
 * `where`, collapse, the union roots) is the relation's to say, not the
 * row's.
 */
export function laneKeepOf(lane: LaneSource, row: object): MemberKeep | null {
  const fields = row as Readonly<Record<string, unknown>>
  return lane.subset.test(fields) ? lane.source.keep(fields) : null
}

/** `schema[entity].cold.finishOf(row)` for an `unlessShown` entity, else null. */
export function coldFinishOf(schema: ModelSchema, entity: EntityName, row: object): number | null {
  const spec = schema[entity].cold
  return spec.kind === 'unlessShown'
    ? spec.finishOf(row as Readonly<Record<string, unknown>>)
    : null
}

/**
 * The ids `rule` collapses away over whole `rows` ({@link collapseLosers} per
 * group): what a from-scratch reader applies before reading a relation.
 */
export function collapsedIds(
  rule: CollapseSpec | undefined,
  rows: Iterable<readonly [string, unknown]>,
): Set<string> {
  const out = new Set<string>()
  if (rule === undefined) return out
  const groups = new Map<string, CollapseMember[]>()
  for (const [id, row] of rows) {
    const fields = row as Readonly<Record<string, unknown>>
    const key = rule.groupKey(fields)
    if (key === null) continue
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [{ id, row: fields }])
    else group.push({ id, row: fields })
  }
  for (const group of groups.values()) for (const id of collapseLosers(rule, group)) out.add(id)
  return out
}

/**
 * A `lane` source over whole tables: lane key → the keeps of the unowned
 * members it seats, resolved from scratch exactly as the engines hold the
 * relation (collapsed twins out, the prefix's `where`, the longest root of
 * the union set: the lane table's keys plus every `alsoRoots` value).
 */
function laneKeepsOver(
  schema: ModelSchema,
  lane: LaneSource,
  tables: (entity: EntityName) => ReadonlyMap<string, unknown> | undefined,
): Map<string, MemberKeep[]> {
  const out = new Map<string, MemberKeep[]>()
  const members = tables(lane.member)
  if (members === undefined) return out
  const roots = new Set<string>(tables(lane.prefix.to)?.keys() ?? [])
  for (const root of extraRootsOf(lane.prefix, (entity) => tables(entity)?.values())) {
    roots.add(root)
  }
  const collapsed = collapsedIds(schema[lane.member].collapse, members)
  for (const [id, row] of members) {
    if (collapsed.has(id)) continue
    const fields = row as Readonly<Record<string, unknown>>
    if (lane.prefix.where !== undefined && !lane.prefix.where.test(fields)) continue
    const keep = laneKeepOf(lane, fields)
    if (keep === null) continue
    const path = fields[lane.prefix.sourceField]
    if (typeof path !== 'string') continue
    let at: string | null = null
    for (const candidate of prefixCandidates(normalizeRootPath(path))) {
      if (roots.has(candidate)) {
        at = candidate
        break
      }
    }
    if (at === null) continue
    const keeps = out.get(at)
    if (keeps === undefined) out.set(at, [keep])
    else keeps.push(keep)
  }
  return out
}

/**
 * The rule over whole row tables at `now`: `coldTarget` recurses by rule over
 * `tables`, `keeps` reads an index of every member row built once here, per
 * source. What a rebuild, a re-partition's staged slice and the gate's check
 * pass. A `lane` source resolves its lanes over the lane table too, so pass
 * every entity's table.
 */
export function tableColdContext(
  schema: ModelSchema,
  tables: (entity: EntityName) => ReadonlyMap<string, unknown> | undefined,
  now: number,
): ColdContext {
  const index = new Map<KeptBySpec, Map<string, MemberKeep[]>>()
  for (const member of keeperEntities(schema)) {
    for (const row of tables(member)?.values() ?? []) {
      const keeper = keeperOf(schema, member, row as object)
      if (keeper === null) continue
      let byKey = index.get(keeper.source)
      if (byKey === undefined) {
        byKey = new Map()
        index.set(keeper.source, byKey)
      }
      const keeps = byKey.get(keeper.id)
      if (keeps === undefined) byKey.set(keeper.id, [keeper.keep])
      else keeps.push(keeper.keep)
    }
  }
  for (const lane of laneSources(schema)) {
    index.set(lane.source, laneKeepsOver(schema, lane, tables))
  }
  const ctx: ColdContext = {
    now,
    summary: (entity, id) => {
      const row = tables(entity)?.get(id) as Readonly<Record<string, unknown>> | undefined
      const spec = schema[entity].cold
      if (row === undefined || spec.kind !== 'unlessShown' || spec.canShow === undefined) return undefined
      return Object.fromEntries(spec.canShow.fields.map((field) => [field, row[field]]))
    },
    coldTarget: (to, id) => {
      const row = tables(to)?.get(id)
      return row !== undefined && coldByRule(schema, to, row as object, ctx)
    },
    keeps: (_entity, source, key) => index.get(source)?.get(key) ?? [],
  }
  return ctx
}

/**
 * {@link coldByRule} for the rows of whole tables at `now`, by entity and id
 * (false for an unknown row): what a test or a measurement partitions a
 * corpus with, instead of restating the rule.
 */
export function tableColdRule(
  schema: ModelSchema,
  tables: (entity: EntityName) => ReadonlyMap<string, unknown> | undefined,
  now: number,
): (entity: EntityName, id: string) => boolean {
  const ctx = tableColdContext(schema, tables, now)
  return (entity, id) => {
    const row = tables(entity)?.get(id)
    return row !== undefined && coldByRule(schema, entity, row as object, ctx)
  }
}

/** Every relation in the schema, with the entity and name it is declared under. */
export function allRelations(
  schema: ModelSchema = SCHEMA,
): { from: EntityName; name: string; relation: RelationSpec }[] {
  const out: { from: EntityName; name: string; relation: RelationSpec }[] = []
  for (const from of Object.keys(schema) as EntityName[]) {
    for (const [name, relation] of Object.entries(schema[from].relations)) {
      out.push({ from, name, relation })
    }
  }
  return out
}

/**
 * The declared resolver for `kind: 'prefix'`, spelled out because a prefix
 * relation is not a key join and every arm re-derived it (round two:
 * `arms/tanstack/collections.ts:195-203`, `arms/hand/indexes.ts`, and the
 * deleted MobX arm).
 *
 * One trailing slash is stripped so `a` and `a/` name one root (`/` is kept —
 * it is a real root and `''` is not). A candidate root matches when it equals
 * the probe or the probe lies strictly inside it; the LONGEST match wins,
 * which reproduces the scan's tie-break
 * (`model/src/identity/worktree.ts:30-47`).
 */
export function normalizeRootPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

export function longestPrefixPath(probePath: string, roots: Iterable<string>): string | null {
  const probe = normalizeRootPath(probePath)
  let best: string | null = null
  for (const raw of roots) {
    const root = normalizeRootPath(raw)
    if (probe !== root && !probe.startsWith(`${root}/`)) continue
    if (best === null || root.length > best.length) best = raw
  }
  return best
}

/**
 * `normalized` and every ancestor at a `/` boundary, longest first: exactly
 * the normalized roots {@link longestPrefixPath} matches for this probe (a
 * root R matches P when P === R or P starts with `R/`). A pool indexes a
 * member under each of these to find, without a scan, the members a new root
 * contains (POD-4579; the same walk as the MobX engine's `ancestorPaths`).
 */
export function* prefixAncestors(normalized: string): Generator<string> {
  yield normalized
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i] === '/') yield normalized.slice(0, i)
  }
}

/**
 * The root KEYS that could match the normalized probe, longest first: each
 * {@link prefixAncestors} path in every spelling that normalizes to it (`a`
 * and `a/`). The first one present in the root set is the answer
 * {@link longestPrefixPath} gives over that set, found by keyed probes
 * instead of a walk (`schema.test.ts` holds the two equal).
 */
export function* prefixCandidates(normalized: string): Generator<string> {
  for (const path of prefixAncestors(normalized)) {
    if (normalizeRootPath(path) === path) yield path
    const slashed = `${path}/`
    if (normalizeRootPath(slashed) === path) yield slashed
  }
}

/**
 * One additional root value of a `prefix` relation on `row` (POD-4671): the
 * raw `field` value when it names a non-empty path, else null. The union root
 * set is the target table's keys plus every such value over every row of
 * every listed source entity.
 */
export function extraRootOf(
  source: { readonly entity: EntityName; readonly field: string },
  row: Readonly<Record<string, unknown>>,
): string | null {
  const value = row[source.field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Every distinct additional root a `prefix` spec names over whole tables
 * (POD-4671): each listed source entity's rows' raw field values, in table
 * order, deduped. The from-scratch scans resolve the spec over the target
 * keys plus this list; the live engines maintain the same union incrementally.
 * `rowsOf` yields the ROWS of an entity (not ids); scans adapt their entry
 * iterators to it.
 */
export function extraRootsOf(
  spec: PrefixSpec,
  rowsOf: (entity: EntityName) => Iterable<unknown> | undefined,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const source of spec.alsoRoots ?? []) {
    for (const row of rowsOf(source.entity) ?? []) {
      const root = extraRootOf(source, row as Readonly<Record<string, unknown>>)
      if (root === null || seen.has(root)) continue
      seen.add(root)
      out.push(root)
    }
  }
  return out
}

/** One row of a collapse group: its entity key and its row. */
export interface CollapseMember {
  readonly id: string
  readonly row: Readonly<Record<string, unknown>>
}

/**
 * The declared resolver for a {@link CollapseSpec}: the ids of `group` (rows
 * sharing one group key) that the rule collapses away. Empty when the group
 * has one row or holds a row that keeps the group; otherwise every row but the
 * kept one — highest `rank`, then the largest `recency` value, then the lower
 * id (the pool's stand-in for the legacy list order; see the rule's `why`).
 */
export function collapseLosers(rule: CollapseSpec, group: readonly CollapseMember[]): string[] {
  if (group.length < 2 || group.some((member) => rule.keepsGroup(member.row))) return []
  let kept = group[0] as CollapseMember
  for (const member of group) if (collapseKeeps(rule, member, kept)) kept = member
  return group.filter((member) => member !== kept).map((member) => member.id)
}

function collapseKeeps(rule: CollapseSpec, a: CollapseMember, b: CollapseMember): boolean {
  const rankA = rule.rank(a.row)
  const rankB = rule.rank(b.row)
  if (rankA !== rankB) return rankA > rankB
  const atA = String(a.row[rule.recency] ?? '')
  const atB = String(b.row[rule.recency] ?? '')
  if (atA !== atB) return atA > atB
  return a.id < b.id
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/**
 * Every structural rule the declaration must satisfy, as a list of findings.
 *
 * Returned rather than thrown so a caller can report all of them at once;
 * `schema.test.ts` asserts the list is EMPTY, and each rule has a negative
 * control there proving it can fire. Source citations (does this field exist
 * in `@podium/model`?) need zod and live in `schema-sources.ts`.
 */
export function validateStructure(schema: ModelSchema = SCHEMA): string[] {
  const problems: string[] = []
  const entities = Object.keys(schema) as EntityName[]
  const at = (from: EntityName, name: string) => `${from}.${name}`

  /** Single-valued edges must be unique: one foreign key, one relation. */
  const singleSignatures = new Map<string, string>()
  /** Each undirected edge must be declared exactly twice — once per side. */
  const pairSides = new Map<string, string[]>()

  for (const from of entities) {
    const entity = schema[from]

    if (!(entity.key in entity.fields)) {
      problems.push(`${from}: key field "${entity.key}" is not declared`)
    }

    for (const [name, component] of Object.entries(entity.components)) {
      if (component.joinKey.length === 0) {
        problems.push(`${from}.components.${name}: empty joinKey`)
      }
    }

    if (entity.cold.kind === 'own' || entity.cold.kind === 'unlessShown') {
      for (const field of entity.cold.dependsOn) {
        if (!(field in entity.fields)) {
          problems.push(`${from}.cold.dependsOn names undeclared field "${field}"`)
        }
      }
    }
    if (entity.cold.kind === 'unlessShown') {
      if (entity.cold.canShow !== undefined) {
        for (const field of entity.cold.canShow.fields) {
          if (!(field in entity.fields)) problems.push(`${from}.cold.canShow names undeclared field "${field}"`)
        }
        const through = entity.relations[entity.cold.canShow.through]
        if (through?.kind !== 'belongsTo' || through.to !== from) {
          problems.push(`${from}.cold.canShow.through must name a self belongsTo`)
        }
      }
      for (const source of entity.cold.keptBy) {
        let member: EntityName
        if (source.kind === 'members') {
          const relation = entity.relations[source.relation]
          const back =
            relation === undefined ? undefined : schema[relation.to].relations[relation.inverse]
          if (relation?.kind !== 'hasMany' || back?.kind !== 'belongsTo') {
            problems.push(`${from}.cold.keptBy must name a hasMany whose inverse is a belongsTo`)
            continue
          }
          member = relation.to
        } else {
          const lane = resolveLane(schema, from, source)
          if (typeof lane === 'string') {
            problems.push(`${from}.cold.keptBy (lane): ${lane}`)
            continue
          }
          member = lane.member
        }
        for (const field of source.dependsOn) {
          if (!(field in schema[member].fields)) {
            problems.push(
              `${from}.cold.keptBy.dependsOn names undeclared ${member} field "${field}"`,
            )
          }
        }
      }
    }
    if (entity.cold.kind === 'via' && !(entity.cold.relation in entity.relations)) {
      problems.push(`${from}.cold.via names undeclared relation "${entity.cold.relation}"`)
    }
    if (entity.cold.kind === 'via') {
      for (const field of entity.cold.unbound?.dependsOn ?? []) {
        if (!(field in entity.fields)) problems.push(`${from}.cold.unbound.dependsOn names undeclared field "${field}"`)
      }
    }

    if (entity.collapse !== undefined) {
      for (const field of [...entity.collapse.fields, entity.collapse.recency]) {
        if (!(field in entity.fields)) {
          problems.push(`${from}.collapse names undeclared field "${field}"`)
        }
      }
      if (!entity.collapse.fields.includes(entity.collapse.recency)) {
        problems.push(`${from}.collapse.recency "${entity.collapse.recency}" is not among its fields`)
      }
    }

    for (const [name, relation] of Object.entries(entity.relations)) {
      const here = at(from, name)

      // A relation and a DECLARED field cannot share a name: the pool
      // composes both onto one instance. The same rule against the model's
      // full row shape needs zod and lives in `validateSources`.
      if (name in entity.fields) {
        problems.push(`${here}: relation name collides with a declared field`)
      }

      const target = schema[relation.to]
      const back = target.relations[relation.inverse]
      if (back === undefined) {
        problems.push(`${here}: inverse "${relation.to}.${relation.inverse}" is not declared`)
        continue
      }
      if (back.to !== from || back.inverse !== name) {
        problems.push(
          `${here}: inverse ${relation.to}.${relation.inverse} points at ${back.to}.${back.inverse}, not back`,
        )
      }

      // Kind duality: belongsTo↔hasMany, prefix↔hasMany, edge(out)↔edge(in).
      const dualOk =
        relation.kind === 'hasMany'
          ? back.kind === 'belongsTo' || back.kind === 'prefix' || (back.kind === 'edge' && back.direction === 'out')
          : relation.kind === 'edge'
            ? back.kind === 'edge' && back.direction !== relation.direction
            : back.kind === 'hasMany'
      if (!dualOk) {
        problems.push(`${here}: kind "${relation.kind}" is not the dual of ${relation.to}.${relation.inverse} ("${back.kind}")`)
      }

      const wantLazy = expectedLazy(schema, relation)
      if (relation.lazy !== wantLazy) {
        problems.push(
          `${here}: lazy=${relation.lazy} contradicts Rule L (target "${relation.to}" cold.kind="${target.cold.kind}" ⇒ lazy=${wantLazy})`,
        )
      }

      if (relation.where !== undefined) {
        for (const field of relation.where.fields) {
          if (!(field in entity.fields)) {
            problems.push(`${here}.where names undeclared field "${field}"`)
          }
        }
      }

      if (relation.kind === 'hasMany') {
        for (const [subset, spec] of Object.entries(relation.subsets ?? {})) {
          if (RESERVED_SUBSET_NAMES.has(subset)) {
            problems.push(`${here}.subsets.${subset}: the name is reserved`)
          }
          if (spec.fields.length === 0) {
            problems.push(`${here}.subsets.${subset}: declares no fields`)
          }
          for (const field of spec.fields) {
            if (!(field in target.fields)) {
              problems.push(`${here}.subsets.${subset} names undeclared ${relation.to} field "${field}"`)
            }
          }
        }
      }

      if (relation.kind === 'belongsTo') {
        if (!(relation.foreignKey in entity.fields)) {
          problems.push(`${here}: foreignKey "${relation.foreignKey}" is not a declared field of ${from}`)
        }
        if (!(relation.targetKey in target.fields)) {
          problems.push(`${here}: targetKey "${relation.targetKey}" is not a declared field of ${relation.to}`)
        }
      }
      if (relation.kind === 'prefix') {
        if (!(relation.sourceField in entity.fields)) {
          problems.push(`${here}: sourceField "${relation.sourceField}" is not a declared field of ${from}`)
        }
        if (!(relation.targetKey in target.fields)) {
          problems.push(`${here}: targetKey "${relation.targetKey}" is not a declared field of ${relation.to}`)
        }
        for (const root of relation.alsoRoots ?? []) {
          const owner = schema[root.entity]
          if (owner === undefined) {
            problems.push(`${here}: alsoRoots names unknown entity "${root.entity}"`)
          } else if (!(root.field in owner.fields)) {
            problems.push(
              `${here}: alsoRoots field "${root.field}" is not a declared field of ${root.entity}`,
            )
          }
        }
      }
      if (relation.kind === 'edge') {
        const owner = relation.direction === 'out' ? entity : target
        const ownerName = relation.direction === 'out' ? from : relation.to
        const field = owner.fields[relation.edgeField]
        if (field === undefined) {
          problems.push(`${here}: edgeField "${relation.edgeField}" is not a declared field of ${ownerName}`)
        } else if (field.type !== 'depEdgeList') {
          problems.push(`${here}: edgeField "${ownerName}.${relation.edgeField}" is type "${field.type}", not an edge list`)
        } else {
          for (const part of [relation.edgeIdKey, relation.edgeTypeKey]) {
            if (field.parts === undefined || !(part in field.parts)) {
              problems.push(`${here}: edge property "${part}" is not declared on ${ownerName}.${relation.edgeField}`)
            }
          }
        }
        if (back.kind === 'edge' && back.edgeType !== relation.edgeType) {
          problems.push(`${here}: edgeType "${relation.edgeType}" disagrees with its inverse "${back.edgeType}"`)
        }
        if (back.kind === 'edge' && (back.allTypes !== relation.allTypes || back.many !== relation.many)) {
          problems.push(`${here}: edge matching/cardinality disagrees with its inverse`)
        }
      }

      // Duplicate detection.
      const pairKey = [here, `${relation.to}.${relation.inverse}`].sort().join(' <-> ')
      pairSides.set(pairKey, [...(pairSides.get(pairKey) ?? []), here])

      // A `where` makes a different edge set over the same key: `issue.parent`
      // (archived and deleted children contribute no edge) and its where-less
      // twin `issue.treeParent` are two edges, a verbatim copy is one.
      const filter = relation.where === undefined ? '' : ` where(${relation.where.fields.join(',')})`
      const signature =
        relation.kind === 'belongsTo'
          ? `belongsTo ${from}.${relation.foreignKey} -> ${relation.to}.${relation.targetKey}${filter}`
          : relation.kind === 'prefix'
            ? `prefix ${from}.${relation.sourceField} -> ${relation.to}.${relation.targetKey}`
            : relation.kind === 'edge' && relation.direction === 'out'
              ? `edge ${from}.${relation.edgeField}[${relation.edgeType}] -> ${relation.to}`
              : null
      if (signature !== null) {
        const seen = singleSignatures.get(signature)
        if (seen !== undefined) {
          problems.push(`${here}: declares the same edge as ${seen} ("${signature}")`)
        } else {
          singleSignatures.set(signature, here)
        }
      }
    }
  }

  for (const [pairKey, sides] of pairSides) {
    if (sides.length !== 2) {
      problems.push(`${pairKey}: declared ${sides.length} time(s) (${sides.join(', ')}), expected exactly 2 — one per side`)
    }
  }

  return problems
}
