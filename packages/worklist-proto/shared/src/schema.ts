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
 * reads more than one entity's fields is not a schema rule.
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
export type ModelSchemaName =
  | 'IssueWire'
  | 'IssueProjection'
  | 'IssueDepWire'
  | 'SessionMeta'
  | 'AgentRuntimeState'
  | 'SessionOffer'
  | 'ResumeRef'
  | 'RepoProjection'
  | 'GitRepositoryWire'
  | 'GitWorktreeWire'

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
  | 'replica:issues'
  | 'replica:issueProjections'
  | 'replica:sessions'
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
}

export interface PrefixSpec extends RelationCommon {
  readonly kind: 'prefix'
  /** The path-valued field on THIS entity being placed. */
  readonly sourceField: string
  /** The path-valued field on `to` that forms the root set. */
  readonly targetKey: string
  /** The resolver. Declared because a prefix relation is not a key join. */
  readonly resolver: 'longestPrefixPath'
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
  | { readonly kind: 'via'; readonly relation: string; readonly why: string }

export interface EntitySpec {
  /** The identity field. */
  readonly key: string
  readonly components: Readonly<Record<string, ComponentSpec>>
  readonly fields: Readonly<Record<string, FieldSpec>>
  readonly relations: Readonly<Record<string, RelationSpec>>
  readonly cold: ColdSpec
  readonly why: string
}

export type ModelSchema = Readonly<Record<EntityName, EntitySpec>>

/** Identity, typed. The schema is data; this only pins its shape. */
function defineSchema(schema: ModelSchema): ModelSchema {
  return schema
}

// ---------------------------------------------------------------------------
// Declaration helpers
// ---------------------------------------------------------------------------

type Opts<T> = Omit<T, 'kind'>

const belongsTo = (spec: Opts<BelongsToSpec>): BelongsToSpec => ({ kind: 'belongsTo', ...spec })
const hasMany = (spec: Opts<HasManySpec>): HasManySpec => ({ kind: 'hasMany', ...spec })
const prefix = (spec: Opts<PrefixSpec>): PrefixSpec => ({ kind: 'prefix', ...spec })
const edge = (spec: Opts<EdgeSpec>): EdgeSpec => ({ kind: 'edge', ...spec })

// ---------------------------------------------------------------------------
// Reusable source shorthands
// ---------------------------------------------------------------------------

const wire = (property?: string): FieldSource => ({
  schema: 'IssueWire',
  arrivesOn: 'replica:issues',
  ...(property === undefined ? {} : { property }),
})
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
// THE SCHEMA
// ---------------------------------------------------------------------------

export const SCHEMA: ModelSchema = defineSchema({
  /**
   * An issue: the wire row joined with its normalized projection row by `id`
   * (slice §1). Both spellings are held; the join key is always `id`.
   */
  issue: {
    key: 'id',
    why: 'The unit of work the worklist draws one row per.',
    components: {
      issue: {
        schema: 'IssueWire',
        arrivesOn: 'replica:issues',
        joinKey: 'id',
        precedence: 0,
        why: 'The legacy embedded wire; carries every field the slice reads, so it wins when present (row-source.ts:330-341).',
      },
      issueProjection: {
        schema: 'IssueProjection',
        arrivesOn: 'replica:issueProjections',
        joinKey: 'id',
        precedence: 1,
        why: "The normalized durable row [POD-796]; the fallback today and the sole source once the authority's flag is on (replica/contract.ts:95-101).",
      },
    },
    fields: {
      id: { type: 'id', source: wire() },
      parentId: { type: 'id', optional: true, nullable: true, source: wire() },
      seq: { type: 'number', source: wire(), note: 'Immutable creation order key (slice §3 R-ORDER).' },
      createdAt: { type: 'isoDate', source: wire() },
      updatedAt: { type: 'isoDate', source: wire() },
      closedAt: { type: 'isoDate', optional: true, nullable: true, source: wire(), note: 'Drives residency: a closed issue is cold.' },
      deletedAt: { type: 'isoDate', optional: true, nullable: true, source: wire() },
      archived: { type: 'boolean', optional: true, source: wire() },
      stage: { type: 'string', source: wire(), note: 'Vocabulary in model/src/predicates/issue-stage.ts; the value set is a view rule (L1b), not a schema rule.' },
      closedReason: { type: 'string', optional: true, nullable: true, source: wire() },
      audience: { type: 'enum', values: ['human', 'agent'], optional: true, source: wire(), note: 'Who the issue is FOR (entities/issue.ts:289).' },
      draft: { type: 'boolean', optional: true, source: wire() },
      pinned: { type: 'boolean', optional: true, source: wire() },
      sortKey: { type: 'string', optional: true, nullable: true, source: wire() },
      deferUntil: { type: 'isoDate', optional: true, nullable: true, source: wire() },
      tuckedAt: { type: 'isoDate', optional: true, nullable: true, source: wire() },
      repoId: { type: 'id', optional: true, nullable: true, source: wire(), note: 'Foreign key of the `repo` relation.' },
      repoPath: { type: 'string', source: wire(), note: 'On the wire only — IssueProjection does not carry it. The repo identity when repoId is absent.' },
      worktreePath: { type: 'string', optional: true, nullable: true, source: wire(), note: 'Foreign key of the `worktree` relation.' },
      coordinatorSessionId: { type: 'id', optional: true, nullable: true, source: wire() },
      startedBySession: { type: 'id', optional: true, nullable: true, source: wire(), note: 'Declared, not read: provenance children are out of the slice (§6).' },
      deps: {
        type: 'depEdgeList',
        source: wire(),
        note: "The wire's denormalization of the first-class `issueDeps` rows (IssueDepProjection, replica/contract.ts:102-105). The feed guarantees an edge change arrives with its owning issue's wire row (row-source.ts:64-70), so the pool reads ONE source.",
        parts: {
          id: { type: 'id', source: { schema: 'IssueDepWire' }, why: 'The other endpoint.' },
          type: { type: 'string', source: { schema: 'IssueDepWire' }, why: 'The edge type; `discovered-from` is the only one in scope.' },
        },
      },
      needsHuman: { type: 'boolean', optional: true, source: wire() },
      blocked: { type: 'boolean', optional: true, source: wire(), note: 'Carried on the wire; the replica also derives it from deps (issue-views.ts:354-356). A field here, not a derivation.' },
      readAt: { type: 'isoDate', optional: true, nullable: true, source: wire(), note: "The per-user cursor. `unread` is NOT a field: it is a rollup over this issue's sessions (issue-views.ts:391-410) and belongs to L1b." },
      title: { type: 'string', source: wire() },
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
        why: "The spin-off's origin (spinOffOriginId, mission.ts:479-483). NOT named `origin`: IssueWire already has an `origin` field (entities/issue.ts:288).",
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
      kind: 'own',
      when: 'closedAt != null',
      dependsOn: ['closedAt'],
      predicate: (row) => row['closedAt'] != null,
      why: 'Audit §7: every issue is instantiated at bootstrap, including ~2,600 closed ones. Closed issues stay on disk until touched.',
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
      sessionId: { type: 'id', source: meta() },
      issueId: { type: 'id', optional: true, nullable: true, source: meta(), note: 'Foreign key of the `issue` relation.' },
      cwd: { type: 'string', source: meta(), note: "The path the `worktree` prefix relation places. There is no `session.worktreePath`." },
      agentKind: { type: 'string', optional: true, nullable: true, source: meta() },
      headless: { type: 'boolean', optional: true, source: meta(), note: 'Structural membership filter on both session relations.' },
      status: { type: 'string', optional: true, nullable: true, source: meta() },
      archived: { type: 'boolean', optional: true, source: meta(), note: 'Read-side filter (L1b), NOT a membership filter: the unread rollup must see the same seats (arms/hand/indexes.ts:26).' },
      lastActiveAt: { type: 'isoDate', source: meta() },
      stoppedAt: { type: 'isoDate', optional: true, nullable: true, source: meta() },
      readAt: { type: 'isoDate', optional: true, nullable: true, source: meta() },
      unread: { type: 'boolean', optional: true, source: meta(), note: "A real field on SessionMeta, unlike the issue's rollup of the same name." },
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
        note: "Resume twins: sessions sharing a ref collapse to one unless any is live/starting/reconnecting (dedupeSessionsByResume, session-identity.ts:45; the runtime applies it to every session read, optimism.ts:876). A whole-kind rule, so the per-row feed cannot apply it; the pool must (POD-4551).",
        parts: {
          kind: { type: 'string', source: { schema: 'ResumeRef' }, why: 'Half of the twin key.' },
          value: { type: 'string', source: { schema: 'ResumeRef' }, why: 'Half of the twin key.' },
        },
      },
    },
    relations: {
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
        why: 'Containment ownership: a session whose cwd sits under a checkout belongs to it and never renders orphaned (session-ownership.ts:161-164).',
        where: {
          fields: ['headless'],
          test: (row) => row['headless'] !== true,
          why: 'A headless session is never a member (slice §2 R3).',
        },
      }),
    },
    cold: {
      kind: 'via',
      relation: 'issue',
      why: "A session is cold exactly when its issue is closed; the session row alone cannot decide it, so residency is inherited through the relation.",
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
 * `arms/tanstack/collections.ts:195-203`, `arms/hand/indexes.ts`,
 * `arms/mobx/store.ts`).
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

    if (entity.cold.kind === 'own') {
      for (const field of entity.cold.dependsOn) {
        if (!(field in entity.fields)) {
          problems.push(`${from}.cold.dependsOn names undeclared field "${field}"`)
        }
      }
    }
    if (entity.cold.kind === 'via' && !(entity.cold.relation in entity.relations)) {
      problems.push(`${from}.cold.via names undeclared relation "${entity.cold.relation}"`)
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
      }

      // Duplicate detection.
      const pairKey = [here, `${relation.to}.${relation.inverse}`].sort().join(' <-> ')
      pairSides.set(pairKey, [...(pairSides.get(pairKey) ?? []), here])

      const signature =
        relation.kind === 'belongsTo'
          ? `belongsTo ${from}.${relation.foreignKey} -> ${relation.to}.${relation.targetKey}`
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
