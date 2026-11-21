import {
  isMachinePathWithinRoot,
  machinePathAncestors,
  machinePathKey,
  machinePathSeparator,
} from '@podium/model/browser'
import { linkKeys, type RecordKind, type RecordLinkField, type RecordReplicaKind, recordOf } from '@podium/model'
import { FULL_DECK_SESSION_FIELDS, MISSION_VIEW_ISSUE_FIELDS, MISSION_VIEW_SESSION_FIELDS } from '../mission-view-schema'

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
 * reads more than one entity's fields is not a schema rule. Which rows are on
 * the device is not a schema rule either: the server's policy and the views'
 * collections decide it (`@podium/model` `records/declarations.ts`), and every
 * row on the device is in the pool (POD-7094).
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
  | 'SlimIssueProjection'
  | 'IssueBriefWire'
  | 'IssueDescriptionWire'
  | 'IssuePanelTodoWire'
  | 'IssuePanelArtifactWire'
  | 'IssuePanelDeferredWire'
  | 'IssuePanelStateWire'
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
  | 'Geometry'
  | 'MachineProjection'
  | 'MachineAccessWire'
  | 'CheckoutWire'
  | 'AutomationWire'
  | 'AutomationRunWire'
  | 'MessageRecordWire'
  | 'MessageLedgerWire'
  | 'PendingInteractionWire'
  | 'EffectRecordWire'
  | 'EffectGroup'
  | 'EffectTarget'
  | 'LayoutWire'
  | 'PinWire'
  | 'TabOrderWire'
  | 'PersonalPreferences'
  | 'InstancePreferences'
  | 'ReadPositionWire'
  | 'SuperagentThreadWire'
  | 'NoticeWire'
  | 'AgentProfileWire'
  | 'WorkflowWire'
  | 'WorkflowRevisionWire'
  | 'WorkflowBindingWire'
  | 'WorkflowRunRecord'
  | 'SubscriptionWire'
  | 'CredentialView'
  | 'MemberView'
  | 'DeviceSignInView'
  | 'RequestRecordKey'

/**
 * Where a row physically arrives from.
 *
 * `replica:<kind>` is the client collection of a declared record type
 * (`@podium/model` `records/declarations.ts`, POD-7084), so only a declared
 * collection can be named. Repository rows and worktree lanes are derived from
 * the `checkout` records (`replica:checkouts`, POD-6644;
 * `shared/checkout-repositories.ts`).
 */
export type RowArrival =
  | `replica:${RecordReplicaKind}`
  | 'request:messages.ledger'
  | 'request:credentials.list'
  | 'request:members.list'
  | 'request:auth.mobileSessions'

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

export type EntityName = 'issueBrief' | 'issueDescription' | 'issuePanelTodo' | 'issuePanelArtifact' | 'issuePanelDeferred' | 'issuePanelState' | 'credential' | 'member' | 'device' | 'repository' | 'issue' | 'session' | 'worktree' | 'repo' | 'machine' | 'automation' | 'automationRun' | 'messageRecord' | 'pendingInteraction' | 'effect' | 'pin' | 'userLayout' | 'tabOrder' | 'userPreferences' | 'userReadPosition' | 'superagentThread' | 'inboxNotice' | 'agentProfile' | 'workflow' | 'workflowRevision' | 'workflowBinding' | 'workflowRun' | 'subscription' | 'instancePreferences'

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

/** Merge verdicts the pool's readers use (`@podium/model`). */
export {
  awaitingMergeOf,
  type MergeVerdictRow,
  unmergedDeliveryOf,
} from '@podium/model/browser'

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
  /**
   * POD-7094 — set when a row of this entity can be absent from the device
   * (history is not on it): a lookup then answers LOADING and asks the one
   * loader for the record. Why, in words. Every row of any other entity the
   * user may see is on the device.
   */
  readonly loadable?: string
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

/**
 * A field of a declared record type (POD-7084): it arrives on that type's
 * client collection, as the record declaration names it.
 */
function recordSource(kind: RecordKind, schema: ModelSchemaName, property?: string): FieldSource {
  return {
    schema,
    arrivesOn: `replica:${recordOf(kind).replicaKind}`,
    ...(property === undefined ? {} : { property }),
  }
}

/** A relation's join keys, read from the record declaration's link (POD-7084). */
function link<K extends RecordKind>(kind: K, field: RecordLinkField<K>) {
  const { foreignKey, targetKey } = linkKeys(kind, field)
  return { foreignKey, targetKey }
}

const derived = (property?: string): FieldSource => recordSource('issueProjection', 'IssueDerived', property)
const projection = (property?: string): FieldSource => recordSource('issueProjection', 'IssueProjection', property)
const sessionValue = (property: string): FieldSource => recordSource('sessionUserState', 'SessionUserStateWire', property)

const meta = (property?: string): FieldSource => recordSource('session', 'SessionMeta', property)
/** The generic tables can receive these synced rows before a screen loads their
 * model definitions. Only identity/residency is needed for ingestion; the
 * deferred synced-models module installs the complete, cited declarations. */
function syncedIdentity(schema: ModelSchemaName, arrivesOn: RowArrival) {
  return {
    key: 'id', components: {}, relations: {},
    fields: { id: { type: 'id' as const, source: { schema, arrivesOn } } },
    why: 'Detailed fields and models register from the deferred synced-models module.',
  }
}
/** One POD-6673 per-user record: keyed by its stamped feed id, always resident. */
function perUser(
  schema: ModelSchemaName,
  arrivesOn: RowArrival,
  why: string,
  fields: Readonly<Record<string, { type: FieldType; note: string; nullable?: true }>>,
) {
  return {
    key: 'id',
    why,
    // No component: the row source stamps the feed id, which no wire row
    // carries, and hands the record over whole.
    components: {},
    fields: {
      id: {
        type: 'id' as const,
        source: { schema: 'RequestRecordKey' as const, arrivesOn },
        note: 'Its feed id, stamped by the row source (the wire row has none).',
      },
      ...Object.fromEntries(
        Object.entries(fields).map(([name, f]) => [
          name,
          { type: f.type, ...(f.nullable ? { nullable: true } : {}), source: { schema, arrivesOn }, note: f.note },
        ]),
      ),
    },
    relations: {},
  }
}
const effectWire = (property?: string): FieldSource => recordSource('effect', 'EffectRecordWire', property)
const scan = (schema: 'GitRepositoryWire' | 'GitWorktreeWire', property?: string): FieldSource => ({
  schema,
  arrivesOn: 'replica:checkouts',
  ...(property === undefined ? {} : { property }),
})

// ---------------------------------------------------------------------------
// Session status vocabulary the resume-twin collapse reads
// (model/src/identity/session-identity.ts:45-72)
// ---------------------------------------------------------------------------

/** A group holding a row in one of these is kept in full. */
const ACTIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(['live', 'starting'])

/** Rank within a collapsing group; anything else (exited) ranks 0. */
const SESSION_STATUS_RANK: Readonly<Record<string, number>> = {
  live: 3,
  starting: 2,
  hibernated: 1,
}

/** `rows.ts:62-69`: archived, deleted, `proposed`, or system-owned (`shipping`). */
export { isExcluded as issueExcluded } from './predicates'

// ---------------------------------------------------------------------------
// THE SCHEMA
// ---------------------------------------------------------------------------

const DECLARED = defineSchema({
  credential: syncedIdentity('CredentialView', 'request:credentials.list'),
  member: syncedIdentity('MemberView', 'request:members.list'),
  device: { ...syncedIdentity('DeviceSignInView', 'request:auth.mobileSessions'), key: 'id',
    fields: { id: { type: 'id', source: { schema: 'DeviceSignInView', arrivesOn: 'request:auth.mobileSessions' } } } },
  repository: syncedIdentity('RequestRecordKey', 'replica:checkouts'),
  /**
   * An issue: its normalized projection joined with personal markers, checkout
   * observations and repository facts at the row-source boundary.
   */
  issue: {
    key: 'id',
    why: 'The unit of work the worklist draws one row per.',
    components: {
      issueProjection: {
        schema: 'SlimIssueProjection',
        arrivesOn: 'replica:issueProjections',
        joinKey: 'id',
        precedence: 0,
        why: 'The normalized durable row owns issue facts and keeps its asked, intentOrigin and isDraftVessel spellings. It carries no body fields: they are records of their own (POD-6921).',
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
      landedAt: { type: 'isoDate', optional: true, nullable: true, source: projection(), note: 'Set by the merge action; the row reads Landed while nothing awaits merge (`issueLanding`).' },
      landedSha: { type: 'string', optional: true, nullable: true, source: projection() },
      audience: { type: 'enum', values: ['human', 'agent'], optional: true, source: projection(), note: 'Who the issue is FOR (entities/issue.ts:289).' },
      isDraftVessel: { type: 'boolean', optional: true, source: projection('isDraftVessel') },
      sortKey: { type: 'string', optional: true, nullable: true, source: projection() },
      deferUntil: { type: 'isoDate', optional: true, nullable: true, source: projection() },
      tuckedAt: { type: 'isoDate', optional: true, nullable: true, source: { schema: 'IssueUserStateWire', arrivesOn: 'replica:issueUserStates' } },
      joinedAt: { type: 'isoDate', optional: true, nullable: true, source: { schema: 'IssueUserStateWire', arrivesOn: 'replica:issueUserStates' }, note: 'The viewer’s own start or join record (POD-6290). Opening, searching or reading never writes it.' },
      joinedVia: { type: 'enum', values: ['start', 'agent', 'join'], optional: true, nullable: true, source: { schema: 'IssueUserStateWire', arrivesOn: 'replica:issueUserStates' }, note: 'How the viewer came to the task: their own start, their agent’s, or an explicit join; the first is kept.' },
      assignedAt: { type: 'isoDate', optional: true, nullable: true, source: { schema: 'IssueUserStateWire', arrivesOn: 'replica:issueUserStates' }, note: 'The viewer’s removable "assigned to you by X" row (POD-6290).' },
      assignedBy: { type: 'id', optional: true, nullable: true, source: { schema: 'IssueUserStateWire', arrivesOn: 'replica:issueUserStates' }, note: 'Who assigned the task to the viewer.' },
      repoId: { type: 'id', optional: true, nullable: true, source: projection(), note: 'Foreign key of the `repo` relation.' },
      repoPath: { type: 'string', source: { schema: 'RepoProjection', arrivesOn: 'replica:repos' }, note: 'Joined through the projection repoId; absent repository facts have not loaded yet.' },
      repoName: { type: 'string', optional: true, source: { schema: 'RepoProjection', arrivesOn: 'replica:repos', property: 'name' }, note: "The repo's server-decided display name (`repo.name`, POD-6246), joined through the projection repoId. Absent until the repo row arrives, or from an older server." },
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
      startedBySession: { type: 'id', optional: true, nullable: true, source: projection(), note: 'Foreign key of the `startedBy` relation: missions and the issue header follow it to the task of the starter session; the sidebar never nests by it.' },
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
      description: { type: 'string', optional: true, source: { schema: 'IssueDescriptionWire', arrivesOn: 'replica:issueDescriptions', property: 'text' }, note: 'Its own synced record (POD-6921): `IssueModel.description` reads the `issueDescription` record; a painted row (launch, fixture) holds its own document.' },
      blockedByNotes: { type: 'object', source: projection() },
      defaultAgent: { type: 'string', source: projection() },
      defaultModel: { type: 'string', source: projection() },
      defaultEffort: { type: 'string', source: projection() },
      agentProfileId: { type: 'id', optional: true, source: projection(), note: 'POD-6107. Read by the profile UI (POD-6098); nothing renders it yet.' },
      machineId: { type: 'id', optional: true, source: projection() },
      ...ISSUE_PAGE_FIELDS,
    },
    relations: {
      briefRecords: hasMany({ to: 'issueBrief', inverse: 'issue', lazy: false, why: 'The brief is its own record, keyed by the issue id (POD-6921).' }),
      descriptionRecords: hasMany({ to: 'issueDescription', inverse: 'issue', lazy: false, why: 'The description is its own record, keyed by the issue id (POD-6921).' }),
      panelTodoRecords: hasMany({ to: 'issuePanelTodo', inverse: 'issue', lazy: false, why: 'Each panel item belongs to its issue.' }),
      panelArtifactRecords: hasMany({ to: 'issuePanelArtifact', inverse: 'issue', lazy: false, why: 'Each panel item belongs to its issue.' }),
      panelDeferredRecords: hasMany({ to: 'issuePanelDeferred', inverse: 'issue', lazy: false, why: 'Each panel item belongs to its issue.' }),
      panelStateRecords: hasMany({ to: 'issuePanelState', inverse: 'issue', lazy: false, why: 'Each panel item belongs to its issue.' }),
      parent: belongsTo({
        to: 'issue',
        ...link('issueProjection', 'parentId'),
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
        why: 'The inverse collection the pool maintains; a child of a held parent may not be on the device.',
      }),
      treeParent: belongsTo({
        to: 'issue',
        ...link('issueProjection', 'parentId'),
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
        ...link('issueProjection', 'startedBySession'),
        inverse: 'startedIssues',
        lazy: true,
        why: "The session that started this issue: provenance for missions and the Flight Deck (poolMissionContains). The sidebar nests by parentId only, never by this.",
      }),
      missionStartedBy: belongsTo({
        to: 'session',
        ...link('issueProjection', 'startedBySession'),
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
        subsets: {
          agents: {
            fields: ['agentKind'],
            test: (row: Readonly<Record<string, unknown>>) => row['agentKind'] !== 'shell',
            why: 'The detail roster counts its collapsed agents, including history, without loading rows.',
          },
          unarchived: {
            fields: ['archived'],
            test: (row: Readonly<Record<string, unknown>>) => !row['archived'],
            why: 'Phone detail reads only the displayed roster while its history fold is closed.',
          },
          retired: {
            fields: ['archived', 'status'],
            test: (row: Readonly<Record<string, unknown>>) =>
              !!row['archived'] || row['status'] === 'exited',
            why: 'The dock counts every retired explicit session, including shells, without loading payloads.',
          },
        },
      }),
      handoffSessions: hasMany({
        to: 'session', inverse: 'handoffIssue', lazy: true,
        why: 'An open task menu asks only how many movable senders it has, or for its sole sender.',
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
        subsets: {
          unarchived: {
            fields: ['archived'],
            test: (row: Readonly<Record<string, unknown>>) => !row['archived'],
            why: 'Active detail sections demand live membership without enumerating hidden archive history.',
          },
        },
      }),
      supersedingIssue: belongsTo({
        to: 'issue', ...link('issueProjection', 'supersededBy'), inverse: 'supersededIssues', lazy: true,
        why: 'The issue page resolves the successor of a superseded task.',
      }),
      supersededIssues: hasMany({ to: 'issue', inverse: 'supersedingIssue', lazy: true, why: 'Inverse successor references.' }),
      canonicalIssue: belongsTo({
        to: 'issue', ...link('issueProjection', 'duplicateOf'), inverse: 'duplicateIssues', lazy: true,
        why: 'The issue page resolves the canonical task of a duplicate.',
      }),
      duplicateIssues: hasMany({ to: 'issue', inverse: 'canonicalIssue', lazy: true, why: 'Inverse duplicate references.' }),
      effects: hasMany({
        to: 'effect',
        inverse: 'issue',
        lazy: false,
        why: "One-off actions on this issue (start, stop, ship, the assistant), each its own record: what the issue shows while one runs (POD-6526).",
      }),
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
        ...link('issueProjection', 'repoId'),
        inverse: 'issues',
        lazy: false,
        why: 'Replaces the denormalized `issue.prefix`: `displayRef` reads `issue.repo.prefix` (replica/contract.ts:106-110).',
      }),
    },
    loadable: 'Only the held collections are on the device; any other issue loads by id, and its stub describes it meanwhile.',
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
      ...FULL_DECK_SESSION_FIELDS,
      sessionId: { type: 'id', source: meta() },
      issueId: { type: 'id', optional: true, nullable: true, source: meta(), note: 'Foreign key of the `issue` relation.' },
      cwd: { type: 'string', source: meta(), note: "The path the `worktree` prefix relation places. There is no `session.worktreePath`." },
      agentKind: { type: 'string', optional: true, nullable: true, source: meta() },
      harnessHandoff: { type: 'boolean', optional: true, source: meta(), note: 'Manifest capability used by the task menu handoff relation.' },
      headless: { type: 'boolean', optional: true, source: meta(), note: 'Structural membership filter on both session relations.' },
      status: { type: 'string', optional: true, nullable: true, source: meta() },
      archived: { type: 'boolean', optional: true, source: meta(), note: 'Read-side filter (L1b), NOT a membership filter: the unread rollup must see the same seats (arms/hand/indexes.ts:26).' },
      lastActiveAt: { type: 'isoDate', source: meta() },
      messageDraft: { type: 'string', optional: true, source: meta(), note: 'SessionMeta.messageDraft; joined from the session Draft Sync v2 document, never copied into conversation machinery.' },
      draftUpdatedAt: { type: 'isoDate', optional: true, source: meta() },
      transcriptAvailable: { type: 'boolean', optional: true, source: meta() },
      queuedMessageCount: { type: 'number', optional: true, source: meta() },
      desired: { type: 'string', optional: true, source: meta() },
      revision: { type: 'number', optional: true, source: meta() },
      observedRevision: { type: 'number', optional: true, source: meta() },
      lifecycleFailure: { type: 'object', optional: true, source: meta() },
      stoppedAt: { type: 'isoDate', optional: true, nullable: true, source: meta() },
      exitCode: { type: 'number', optional: true, source: meta(), note: 'With stopReason and spawnFailure, what the state word reads to tell a crash or failed start (Error) from a stop (Done), D5.' },
      spawnFailure: { type: 'string', optional: true, source: meta() },
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
        note: "Resume twins: sessions sharing a ref collapse to one unless any is live/starting. The pool's declared session.collapse keeps the survivor consistent across per-row readers (POD-4566).",
        parts: {
          kind: { type: 'string', source: { schema: 'ResumeRef' }, why: 'Half of the twin key.' },
          value: { type: 'string', source: { schema: 'ResumeRef' }, why: 'Half of the twin key.' },
        },
      },
      refIssueId: { type: 'id', optional: true, source: meta() },
      // What the model and mode chips and the posture notices read off the
      // shared session model (POD-7002). Without a line here the model has no
      // getter, the read is undefined, and the chat view drew neither chip.
      observedModel: { type: 'string', optional: true, source: meta() },
      observedEffort: { type: 'string', optional: true, source: meta() },
      requestedModel: { type: 'string', optional: true, source: meta() },
      requestedEffort: { type: 'string', optional: true, source: meta() },
      configureFields: { type: 'object', optional: true, source: meta(), note: 'The fields this driver can change mid-session; empty is an answer (none), absent is unknown.' },
      observedMode: { type: 'string', optional: true, source: meta(), note: 'The mode the harness reports it is in (POD-6858).' },
      launchPosture: { type: 'object', optional: true, source: meta(), note: 'The last launch\'s requested mode and unmet requirements (POD-6858).' },
      ...ISSUE_PAGE_SESSION_FIELDS,
    },
    relations: {
      bornIssue: belongsTo({
        to: 'issue', ...link('session', 'refIssueId'),
        inverse: 'bornSessions', lazy: true,
        why: 'The permanent creation issue, independent of the current attachment.',
      }),
      pageIssue: belongsTo({
        to: 'issue', ...link('session', 'issueId'),
        inverse: 'pageSessions', lazy: true, uncollapsed: true,
        where: { fields: ['agentKind'], test: row => row['agentKind'] !== 'shell',
          why: 'Replica issue membership includes raw headless/archived/resume-twin rows, excluding shells.' },
        why: 'The replica page membership contract before visual resume collapse.',
      }),
      effects: hasMany({
        to: 'effect',
        inverse: 'session',
        lazy: false,
        why: 'One-off actions on this session (a Stop is a `session.interrupt`), each its own record (POD-6397).',
      }),
      startedIssues: hasMany({
        to: 'issue',
        inverse: 'startedBy',
        lazy: true,
        why: "The issues this session started, the inverse of startedBy: provenance for missions and the Flight Deck. The sidebar never nests by it.",
      }),
      missionStartedIssues: hasMany({
        to: 'issue',
        inverse: 'missionStartedBy',
        lazy: true,
        why: 'Eligible mission provenance candidates, maintained from the declared starter edge.',
      }),
      missionIssue: belongsTo({
        to: 'issue',
        ...link('session', 'issueId'),
        inverse: 'missionSessions',
        lazy: true,
        why: 'missionSessionIndex uses explicit issueId ownership, including headless and archived sessions.',
      }),
      handoffIssue: belongsTo({
        to: 'issue', ...link('session', 'issueId'), inverse: 'handoffSessions', lazy: true,
        where: {
          fields: ['agentKind', 'harnessHandoff'],
          test: row => row['agentKind'] !== 'shell' && row['harnessHandoff'] === true,
          why: 'The manifest capability decides handoff subjects, including archived and headless attachments.',
        },
        why: 'Menu handoff eligibility without loading the issue session history.',
      }),
      issue: belongsTo({
        to: 'issue',
        ...link('session', 'issueId'),
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
      why: "Resume twins: session rows pointing at the SAME agent conversation collapse to the most useful one (live > starting > hibernated > exited, then the most recently active), EXCEPT that a group holding an active row is kept in full. A headless row never takes part: it shares its terminal twin's ref by design. On an exact tie of rank and recency the legacy keeps the row earlier in the runtime's list, an order a pool does not have; the lower session id is kept instead.",
    },
    loadable: 'Only the held collections are on the device; any other session loads by id. Sessions have no stub.',
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
        arrivesOn: 'replica:checkouts',
        joinKey: 'path',
        precedence: 0,
        why: 'One lane per scanned worktree (GitRepositoryWire.worktrees[], row-source.ts:319-321).',
      },
      repoRoot: {
        schema: 'GitRepositoryWire',
        arrivesOn: 'replica:checkouts',
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
            why: "The lane's sessions no explicit owner claims (`indexSessionOwnership`, session-ownership.ts:152-158: the legacy tests `issueId !== undefined`, so an explicit null still claims). They seat by containment under the issues checked out here (R3).",
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
        ...link('checkout', 'repoId'),
        inverse: 'worktrees',
        lazy: false,
        why: 'The lane’s repo, for the group key, label and prefix.',
      }),
    },
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
        arrivesOn: 'replica:checkouts',
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
      defaultParentBranch: { type: 'string', optional: true, nullable: true, source: { schema: 'RepoProjection', arrivesOn: 'replica:repos' }, note: "The repo's base branch [POD-2065]. Absent defers to `gitWorkflow.defaultParentBranch`, then auto-detection." },
      name: { type: 'string', optional: true, nullable: true, source: { schema: 'RepoProjection', arrivesOn: 'replica:repos' }, note: "The repo's display name, decided by the server from its git remote (POD-6246). Every surface reads this; none derives a name from a path." },
      path: { type: 'string', source: scan('GitRepositoryWire'), note: 'A checkout path. Never the source of the repo name (POD-6246).' },
    },
    relations: {
      issues: hasMany({ to: 'issue', inverse: 'repo', lazy: true, why: 'Every issue in the repo; holds closed ones.' }),
      worktrees: hasMany({ to: 'worktree', inverse: 'repo', lazy: false, why: 'The repo’s lanes.' }),
    },
  },
  /**
   * A one-off action outside the database, as data (ADR 12 D5 E2): a merge, a
   * file write, a Stop. Its status moves on the record, so every device shows
   * the same answer to "did it happen?" (POD-6397).
   */
  effect: {
    key: 'id',
    why: 'One shared record per effect: the composer, a session bar or a task row each read the same model.',
    components: {
      record: {
        schema: 'EffectRecordWire',
        arrivesOn: 'replica:effects',
        joinKey: 'id',
        precedence: 0,
        why: 'The generic effect record the feed carries.',
      },
    },
    fields: {
      // Identity and intent
      id: { type: 'id', source: effectWire() },
      kind: { type: 'string', source: effectWire(), note: '`session.interrupt`, `issue.merge`, `file.write`, …' },
      target: { type: 'object', source: effectWire(), parts: {
        kind: { type: 'enum', source: { schema: 'EffectTarget' }, why: 'What the effect acts on, and so who sees it.' },
        id: { type: 'id', source: { schema: 'EffectTarget' }, why: 'The target record.' },
      } },
      sessionId: { type: 'id', optional: true, source: effectWire('target'), note: "Stamped at the row-source boundary from a session target's id: the key of the `session` relation." },
      issueId: { type: 'id', optional: true, source: effectWire('target'), note: "Stamped at the row-source boundary from an issue target's id: the key of the `issue` relation." },
      input: { type: 'object', source: effectWire(), note: 'What the kind publishes of its input.' },
      cancelRequested: { type: 'boolean', source: effectWire() },
      decision: { type: 'enum', values: ['approve', 'deny'], optional: true, nullable: true, source: effectWire(), note: "A human gate's decision (POD-6674): `null` while an approval waits for its person." },
      deciders: { type: 'object', optional: true, source: effectWire(), note: 'Who a gated record is routed to (POD-6674); absent: its creator.' },
      forViewer: { type: 'boolean', optional: true, source: effectWire('deciders'), note: 'Stamped at the row-source boundary: the viewer is one the record is routed to, its deciders or else its creator (POD-6674).' },
      createdBy: { type: 'id', nullable: true, source: effectWire() },
      createdAt: { type: 'isoDate', source: effectWire() },
      updatedAt: { type: 'isoDate', source: effectWire() },
      revision: { type: 'number', source: effectWire() },
      // Progress and outcome
      effect: { type: 'object', source: effectWire(), parts: {
        status: { type: 'enum', source: { schema: 'EffectGroup' }, why: 'The standard effect status.' },
        stage: { type: 'string', optional: true, source: { schema: 'EffectGroup' }, why: 'Kind-specific progress while running.' },
        error: { type: 'object', optional: true, source: { schema: 'EffectGroup' }, why: 'Why it failed, for a person.' },
        deadline: { type: 'isoDate', optional: true, source: { schema: 'EffectGroup' }, why: 'When it gives up.' },
      } },
      result: { type: 'object', optional: true, source: effectWire(), note: "The kind's small answer." },
    },
    relations: {
      session: belongsTo({
        to: 'session',
        foreignKey: 'sessionId',
        targetKey: 'sessionId',
        inverse: 'effects',
        lazy: true,
        why: 'The session an effect acts on (a Stop), for its `effects` collection.',
      }),
      issue: belongsTo({
        to: 'issue',
        foreignKey: 'issueId',
        targetKey: 'id',
        inverse: 'effects',
        lazy: true,
        why: 'The issue an effect acts on (a start, a stop), for its `effects` collection.',
      }),
    },
  },
  /**
   * MY PINS, TAB ORDERS, PERSONAL SETTINGS AND READ POSITIONS (POD-6673): synced
   * per-user records, the owner's alone. Each is one row keyed by its feed id,
   * which the row source stamps as `id`.
   */
  pin: perUser('PinWire', 'replica:pins', 'The record IS the pin: a session, issue, worktree or repo I pinned.', {
    userId: { type: 'id', note: 'Its owner: always the principal.' },
    kind: { type: 'enum', note: '`panel` (a session), `issue`, `worktree` or `repo`.' },
    entityId: { type: 'string', note: 'The pinned thing: a session or issue id, or a path.' },
    pinnedAt: { type: 'isoDate', note: 'When; pinned things list in this order.' },
  }),
  userLayout: perUser('LayoutWire', 'replica:userLayouts', 'One synced personal layout choice.', {
    userId: { type: 'id', note: 'Owner.' },
    key: { type: 'string', note: 'Layout key.' },
    value: { type: 'object', note: 'The user’s chosen value.' },
  }),
  tabOrder: perUser('TabOrderWire', 'replica:tabOrders', 'My manual session order of one worktree.', {
    userId: { type: 'id', note: 'Its owner: always the principal.' },
    entityId: { type: 'string', note: 'The worktree path.' },
    sessionIds: { type: 'object', note: 'The order, whole: the last writer wins.' },
  }),
  userPreferences: perUser(
    'PersonalPreferences',
    'replica:userPreferences',
    'My personal settings: one record, resolved with defaults by the row source from its flat leaf fields.',
    {
      userId: { type: 'id', note: 'Its owner: always the principal. Also the record id.' },
      roles: { type: 'object', note: 'Agent and model choices per role (coding, superagent, background, shipwright).' },
      sidebar: { type: 'object', note: 'Repo sort, manual repo order, grouping.' },
      autoContinue: { type: 'object', note: 'Retry-on-error, and whether its prompt was answered.' },
      notifications: { type: 'object', note: 'Where my notifications go (web, ntfy topic, Telegram chat).' },
      credentialDefaults: {
        type: 'object',
        note: 'Per harness, the credential a launch uses when it names none (credential management §9).',
      },
    },
  ),
  userReadPosition: perUser('ReadPositionWire', 'replica:userReadPositions', 'How far I have read one event stream.', {
    userId: { type: 'id', note: 'Its owner: always the principal.' },
    streamId: { type: 'enum', note: 'The stream (`issueEvents`).' },
    lastEventId: { type: 'number', note: 'The last event read; only ever moves forward.' },
    seenAt: { type: 'isoDate', nullable: true, note: 'When it was read.' },
  }),
  /**
   * MY SUPERAGENT THREADS (POD-6675): synced per-user records, the owner's alone.
   * The open thread is UiStore state (POD-5797), not a field here.
   */
  superagentThread: perUser('SuperagentThreadWire', 'replica:superagentThreads', 'One of my superagent threads: the global one, a session\'s btw thread or a repo\'s concierge.', {
    threadId: { type: 'id', note: 'The thread id the superagent commands take (`global`, `btw_<session>`, …).' },
    ownerUserId: { type: 'id', note: 'Its owner: always the principal.' },
    kind: { type: 'enum', note: '`global`, `btw` or `concierge`.' },
    originSessionId: { type: 'id', note: 'A btw thread\'s session; absent on the others.' },
    repoPath: { type: 'string', note: 'A concierge thread\'s repo; absent on the others.' },
    agentKind: { type: 'string', note: 'The harness the thread last ran.' },
    podiumSessionId: { type: 'id', note: 'The headless session that renders the thread; absent until it has one.' },
    title: { type: 'string', note: 'Its title (spec: my edit).' },
    archived: { type: 'boolean', note: 'Archived (spec: my edit); the global thread never is.' },
    model: { type: 'string', note: 'Its own model (spec); absent follows the superagent settings role.' },
    effort: { type: 'string', note: 'Its own effort (spec); absent follows the role.' },
    resumable: { type: 'boolean', note: 'The server holds a harness conversation, so it can open in a terminal.' },
    turnRunning: { type: 'boolean', note: 'A turn is running (status, set at turn start and end).' },
    lastTurnFailure: { type: 'object', nullable: true, note: 'The last turn failed (status); cleared when the next one starts.' },
    createdAt: { type: 'isoDate', note: 'When it was made.' },
    updatedAt: { type: 'isoDate', note: 'Its last conversation write; threads list newest first.' },
  }),
  /**
   * MY OPEN NOTICES (POD-6881, spec §13): synced per-user records, the
   * recipient's alone. A resolved notice leaves the feed, so every row here
   * still needs me.
   */
  inboxNotice: perUser(
    'NoticeWire',
    'replica:inboxNotices',
    'One open notice for me: a mention, a credential that needs attention, a credential shared with me.',
    {
      noticeId: { type: 'id', note: 'The notice id `notices.markRead` takes.' },
      recipientUserId: { type: 'id', note: 'Its recipient: always the principal.' },
      kind: {
        type: 'string',
        note: '`mention`, `credential-attention` or `credential-shared`; open, so a newer kind still shows.',
      },
      subjectKind: {
        type: 'string',
        note: 'What it is about: `issue`, `credential`, `session`, …',
      },
      subjectId: { type: 'id', note: 'The id of what it is about.' },
      subjectAnchor: {
        type: 'string',
        note: 'A place inside the subject: the comment of a mention.',
      },
      title: { type: 'string', note: 'One line, worded for me.' },
      body: { type: 'string', note: 'A line of text under the title; never a secret.' },
      createdAt: { type: 'isoDate', note: 'When it was raised; the inbox lists newest first.' },
      readAt: { type: 'isoDate', note: 'When I read it; absent while unread.' },
    },
  ),
  /**
   * THE INSTANCE SETTINGS (POD-6677): one synced record, every member's, keyed
   * `INSTANCE_PREFERENCES_ROW_ID`. The row source resolves its flat leaf fields
   * into the groups below, each whole with its defaults.
   */
  instancePreferences: perUser(
    'InstancePreferences',
    'replica:instancePreferences',
    'The instance settings: one record for the whole instance, admin-written, resolved with defaults.',
    {
      hibernation: { type: 'object', note: 'When idle sessions are parked: memory, load and count ceilings.' },
      gitWorkflow: { type: 'object', note: 'Default parent branch, merge style, rebase before merge.' },
      issues: { type: 'object', note: 'Whether the issue assistant runs.' },
      steward: { type: 'object', note: 'Whether the steward runs.' },
      experimental: { type: 'object', note: 'The operator’s experimental feature toggles, by flag id.' },
      worktreeGc: { type: 'object', note: 'Clean-up of closed issues’ worktrees.' },
      transcripts: { type: 'object', note: 'Whether the server keeps a copy of agent transcripts.' },
      deployment: { type: 'object', note: 'Deployment choices: update channel, open sign-up, telemetry.' },
    },
  ),
  messageRecord: syncedIdentity('MessageRecordWire', 'replica:messageRecords'),
  pendingInteraction: syncedIdentity('PendingInteractionWire', 'replica:pendingInteractions'),
  machine: syncedIdentity('MachineProjection', 'replica:machines'),
  automation: syncedIdentity('AutomationWire', 'replica:automations'),
  automationRun: syncedIdentity('AutomationRunWire', 'replica:automationRuns'),
  // POD-6676: agent profiles, workflows and trigger subscriptions; their fields
  // and models register from the deferred `workflow-models` module.
  agentProfile: syncedIdentity('AgentProfileWire', 'replica:agentProfiles'),
  workflow: syncedIdentity('WorkflowWire', 'replica:workflows'),
  workflowRevision: syncedIdentity('WorkflowRevisionWire', 'replica:workflowRevisions'),
  workflowBinding: syncedIdentity('WorkflowBindingWire', 'replica:workflowBindings'),
  workflowRun: syncedIdentity('WorkflowRunRecord', 'replica:workflowRuns'),
  issuePanelTodo: { key: 'id', why: 'One durable panel record.', components: {},
    fields: {
      id: { type: 'id', source: { schema: 'IssuePanelTodoWire', arrivesOn: 'replica:issuePanelTodos' } },
      issueId: { type: 'id', source: { schema: 'IssuePanelTodoWire', arrivesOn: 'replica:issuePanelTodos' } },
      position: { type: 'number', source: { schema: 'IssuePanelTodoWire', arrivesOn: 'replica:issuePanelTodos' } },
      text: { type: 'string', source: { schema: 'IssuePanelTodoWire', arrivesOn: 'replica:issuePanelTodos' } },
      done: { type: 'boolean', source: { schema: 'IssuePanelTodoWire', arrivesOn: 'replica:issuePanelTodos' } },
    }, relations: { issue: belongsTo({ to: 'issue', ...link('issuePanelTodo', 'issueId'), inverse: 'panelTodoRecords', lazy: true, why: 'The parent issue.' }) } },
  issuePanelArtifact: { key: 'id', why: 'One durable panel record.', components: {},
    fields: {
      id: { type: 'id', source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      issueId: { type: 'id', source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      position: { type: 'number', source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      path: { type: 'string', source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      title: { type: 'string', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      addedAt: { type: 'isoDate', source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      artifactId: { type: 'id', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      entry: { type: 'string', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      files: { type: 'object', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      sourcePaths: { type: 'object', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      sourceKind: { type: 'enum', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      chatUploadId: { type: 'string', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      chatUploadOwner: { type: 'id', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      tracking: { type: 'enum', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
      untrackedPaths: { type: 'object', optional: true, source: { schema: 'IssuePanelArtifactWire', arrivesOn: 'replica:issuePanelArtifacts' } },
    }, relations: { issue: belongsTo({ to: 'issue', ...link('issuePanelArtifact', 'issueId'), inverse: 'panelArtifactRecords', lazy: true, why: 'The parent issue.' }) } },
  issuePanelDeferred: { key: 'id', why: 'One durable panel record.', components: {},
    fields: {
      id: { type: 'id', source: { schema: 'IssuePanelDeferredWire', arrivesOn: 'replica:issuePanelDeferreds' } },
      issueId: { type: 'id', source: { schema: 'IssuePanelDeferredWire', arrivesOn: 'replica:issuePanelDeferreds' } },
      position: { type: 'number', source: { schema: 'IssuePanelDeferredWire', arrivesOn: 'replica:issuePanelDeferreds' } },
      text: { type: 'string', source: { schema: 'IssuePanelDeferredWire', arrivesOn: 'replica:issuePanelDeferreds' } },
      addedAt: { type: 'isoDate', source: { schema: 'IssuePanelDeferredWire', arrivesOn: 'replica:issuePanelDeferreds' } },
    }, relations: { issue: belongsTo({ to: 'issue', ...link('issuePanelDeferred', 'issueId'), inverse: 'panelDeferredRecords', lazy: true, why: 'The parent issue.' }) } },
  issuePanelState: { key: 'id', why: 'One durable panel record.', components: {},
    fields: {
      id: { type: 'id', source: { schema: 'IssuePanelStateWire', arrivesOn: 'replica:issuePanelStates' } },
      text: { type: 'string', source: { schema: 'IssuePanelStateWire', arrivesOn: 'replica:issuePanelStates' } },
      updatedAt: { type: 'isoDate', source: { schema: 'IssuePanelStateWire', arrivesOn: 'replica:issuePanelStates' } },
    }, relations: { issue: belongsTo({ to: 'issue', ...link('issuePanelState', 'id'), inverse: 'panelStateRecords', lazy: true, why: 'The parent issue.' }) } },
  issueBrief: { key: 'id', why: 'An issue brief, its own synced record (POD-6921).', components: {},
    fields: {
      id: { type: 'id', source: { schema: 'IssueBriefWire', arrivesOn: 'replica:issueBriefs' } },
      text: { type: 'string', source: { schema: 'IssueBriefWire', arrivesOn: 'replica:issueBriefs' } },
    }, relations: { issue: belongsTo({ to: 'issue', ...link('issueBrief', 'id'), inverse: 'briefRecords', lazy: true, why: 'The parent issue.' }) } },
  issueDescription: { key: 'id', why: 'An issue description, its own synced record (POD-6921).', components: {},
    fields: {
      id: { type: 'id', source: { schema: 'IssueDescriptionWire', arrivesOn: 'replica:issueDescriptions' } },
      text: { type: 'string', source: { schema: 'IssueDescriptionWire', arrivesOn: 'replica:issueDescriptions' } },
    }, relations: { issue: belongsTo({ to: 'issue', ...link('issueDescription', 'id'), inverse: 'descriptionRecords', lazy: true, why: 'The parent issue.' }) } },
  subscription: syncedIdentity('SubscriptionWire', 'replica:subscriptions'),
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
 * A relation is lazy iff its TARGET entity can be absent from the device
 * (`loadable`): reading `issue.sessions` of an issue whose sessions the
 * device does not hold can still require a load. Callers of a lazy relation
 * must handle the unhydrated state (audit §7: "type-level marking of
 * unhydrated relations"); callers of a non-lazy one never see it.
 *
 * `schema.test.ts` recomputes every declared flag from this function, so a
 * hand-edited flag fails the test.
 */
export function expectedLazy(schema: ModelSchema, relation: RelationSpec): boolean {
  return schema[relation.to].loadable !== undefined
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
  if (machinePathSeparator(path) === '\\') return machinePathKey(path)
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

export function longestPrefixPath(probePath: string, roots: Iterable<string>): string | null {
  const probe = normalizeRootPath(probePath)
  let best: string | null = null
  for (const raw of roots) {
    const root = normalizeRootPath(raw)
    if (machinePathSeparator(root) === '\\') {
      if (!isMachinePathWithinRoot(root, probe)) continue
    } else if (probe !== root && !probe.startsWith(`${root}/`)) continue
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
  if (machinePathSeparator(normalized) === '\\') {
    yield* machinePathAncestors(normalized)
    return
  }
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
          `${here}: lazy=${relation.lazy} contradicts Rule L (target "${relation.to}" loadable=${target.loadable !== undefined} ⇒ lazy=${wantLazy})`,
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
