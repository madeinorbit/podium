/**
 * POD-5593 — the active-work rule: which rows belong to the first screen and
 * which are history. One definition for the pool's residency, the server's
 * active-first bootstrap and the disk stores' active tag.
 *
 * A row is ACTIVE when it is not cold by {@link coldByRule}. The rule is
 * declared per entity ({@link ColdSpec}): `never` is always active, `own`
 * is a predicate over the row, `via` inherits its target's answer through a
 * named `belongsTo`, and `unlessShown` (the issue, POD-4665) is history only
 * when its predicate holds and every deadline, its own and each member's,
 * has passed. The issue's and the session's declarations are
 * {@link ISSUE_ACTIVE_WORK} and {@link SESSION_ACTIVE_WORK}.
 *
 * THE CLOCK IS AN INPUT. Every deadline is read against `ctx.now` (epoch ms);
 * nothing here reads the wall clock, so a server snapshot, a disk re-tag and
 * the pool answer the same at the same instant.
 *
 * THE LINKS ARE THE CALLER'S. A declaration names the relations it follows
 * (`via: 'issue'`, `keptBy: 'sessions'`, the lane through `worktree`); the
 * evaluator resolves those names against the schema it is given
 * ({@link ActiveWorkSchema}), and the caller's {@link ColdContext} answers for
 * the rows they reach. The pool passes its declared schema
 * (`packages/client-graph/src/shared/schema.ts`).
 */

import { canonicalIssueCloseReason } from '../entities/issue-status'
import { isClosed, isExcluded, isFinished } from './issue-lifecycle'

/** A row as the rule reads it: its declared fields, by name. */
export type ActiveWorkRow = Readonly<Record<string, unknown>>

// ---------------------------------------------------------------------------
// The rule's declarations
// ---------------------------------------------------------------------------

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
      readonly predicate: (row: ActiveWorkRow) => boolean
      readonly why: string
    }
  | {
      readonly kind: 'via'
      readonly relation: string
      /** Own decay when the raw reference is absent; a missing referenced row stays conservative. */
      readonly unbound?: {
        readonly dependsOn: readonly string[]
        readonly predicate: (row: ActiveWorkRow) => boolean
        readonly shownUntil: (row: ActiveWorkRow) => number
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
  readonly predicate: (row: ActiveWorkRow) => boolean
  /** Structural/placement bound, shared with member-triggered warming. */
  readonly canShow?: {
    /** Small summary kept for cold rows; never the full row. */
    readonly fields: readonly string[]
    /** Ancestor relation whose inverse must be revisited when an ancestor changes. */
    readonly through: string
    readonly test: (row: ActiveWorkRow, ctx: ColdContext) => boolean
  }
  /** The last instant the row can show on its own; `-Infinity` never, `Infinity` without limit. */
  readonly shownUntil: (row: ActiveWorkRow) => number
  /**
   * The instant a member's {@link MemberKeep} function decays from, or null
   * when it does not decay at all (read by the member side only).
   */
  readonly finishOf: (row: ActiveWorkRow) => number | null
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
  readonly keep: (member: ActiveWorkRow) => MemberKeep
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
  readonly keep: (member: ActiveWorkRow) => MemberKeep
  readonly why: string
}

/**
 * How long one member can keep its row shown: a deadline, or a function of
 * the row's {@link UnlessShownColdSpec.finishOf} (an idle session whose turn
 * finished decays from its issue's finish, `visibility.ts:51-58`).
 */
export type MemberKeep = number | ((finish: number) => number)

/**
 * What {@link coldByRule} asks of its caller. A pool answers from what it
 * holds; a rebuild, a re-partition and the gate's check answer from whole
 * row tables (`tableColdContext` in the pool schema).
 */
export interface ColdContext<E extends string = string> {
  /** The slice clock (`coarseNow`, epoch ms) every deadline is read against. */
  readonly now: number
  /** Whether `to:id` is known and cold by rule (a `via` row's target). */
  coldTarget(to: E, id: string): boolean
  /** Only the entity's declared canShow summary, from resident input or a cold summary. */
  summary?(entity: E, id: string): ActiveWorkRow | undefined
  /**
   * The keeps of the members one `source` of an `unlessShown` entity's
   * `keptBy` holds at `key` ({@link keptByKey}): for `members`, every member
   * row naming the row by the raw foreign key with the relation's `where`
   * passed; for `lane`, every unowned member the lane named `key` seats.
   */
  keeps(entity: E, source: KeptBySpec, key: string): Iterable<MemberKeep>
}

/**
 * The most of a schema the rule reads: each entity's identity field, the
 * declared rule, and the `belongsTo` relations a `via` rule or a `lane`
 * source names. The pool's declared schema is one.
 */
export interface ActiveWorkEntity<E extends string = string> {
  readonly key: string
  readonly cold: ColdSpec
  readonly relations: Readonly<Record<string, { readonly kind: string; readonly to?: E; readonly foreignKey?: string }>>
}

/** A schema by entity name `E`; the evaluator's answers name the same entities. */
export type ActiveWorkSchema<E extends string = string> = Readonly<Record<E, ActiveWorkEntity<E>>>

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

/**
 * Whether `row` of `entity` may stay out of memory (is history, not active
 * work), by `schema[entity].cold`: `never` is always resident, `own` is the
 * entity's predicate over its row, `via` is cold when the row it inherits from
 * ({@link viaTargetOf}) is known and cold by rule, which `ctx.coldTarget`
 * answers; `unlessShown` is cold when its predicate holds and every deadline,
 * its own and each member's of every source, has passed at `ctx.now`
 * (POD-4665, POD-4745). One rule for the pool, its rebuild, the gate's
 * partition check (POD-4580), the server and the disk stores (POD-5593).
 */
export function coldByRule<E extends string>(
  schema: ActiveWorkSchema<E>,
  entity: NoInfer<E>,
  row: object,
  ctx: ColdContext<NoInfer<E>>,
): boolean {
  const spec = schema[entity].cold
  const fields = row as ActiveWorkRow
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

/** `entity.relations[name]` as the `belongsTo` it must be: its target and raw foreign key. */
function belongsToOf<E extends string>(
  schema: ActiveWorkSchema<E>,
  entity: E,
  name: string,
  role: string,
): { readonly to: E; readonly foreignKey: string } {
  const relation = schema[entity].relations[name]
  if (relation?.kind !== 'belongsTo' || relation.to === undefined || relation.foreignKey === undefined) {
    throw new Error(`[schema] ${entity}.${role} must name a belongsTo (got ${relation?.kind})`)
  }
  return { to: relation.to, foreignKey: relation.foreignKey }
}

/**
 * The row a `via` entity inherits residency from (its `cold.relation`'s
 * RAW foreign key: residency follows the reference, not the relation's
 * `where`, so a headless session of a closed issue is cold too), or null.
 */
export function viaTargetOf<E extends string>(
  schema: ActiveWorkSchema<E>,
  entity: NoInfer<E>,
  row: object,
): { readonly to: E; readonly id: string } | null {
  const spec = schema[entity].cold
  if (spec.kind !== 'via') return null
  const relation = belongsToOf(schema, entity, spec.relation, 'cold.via')
  const key = (row as ActiveWorkRow)[relation.foreignKey]
  return typeof key === 'string' && key.length > 0 ? { to: relation.to, id: key } : null
}

/**
 * Where `source` holds the members of `row` of the `unlessShown` entity
 * `entity`: its own key for `members`; the raw foreign key of `through` (its
 * lane) for `lane`. Null when the row has none.
 */
export function keptByKey<E extends string>(
  schema: ActiveWorkSchema<E>,
  entity: NoInfer<E>,
  row: object,
  source: KeptBySpec,
): string | null {
  const fields = row as ActiveWorkRow
  const field =
    source.kind === 'members'
      ? schema[entity].key
      : belongsToOf(schema, entity, source.through, 'cold.keptBy (lane) through').foreignKey
  const key = fields[field]
  return typeof key === 'string' && key.length > 0 ? key : null
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

/** Cancelled, duplicate and superseded work contributes no remaining progress. */
export function issueAbandoned(issue: { readonly stage?: unknown; readonly closedReason?: unknown }): boolean {
  const reason = canonicalIssueCloseReason(issue.closedReason)
  const status = reason ?? (isClosed(issue) ? 'done' : issue.stage)
  return status === 'cancelled' || status === 'duplicate' || status === 'superseded'
}

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
function issueShownUntil(row: ActiveWorkRow): number {
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
function issueFinishOf(row: ActiveWorkRow): number | null {
  return isFinished(row) ? epochMs(row['closedAt'] ?? row['updatedAt']) : null
}

/**
 * Internal children only render under a placed, non-agent ancestor. An
 * excluded or cold human ancestor cannot be that row at this clock. Walk
 * the raw tree, as nesting does; an unknown ancestor remains conservative.
 * Parentless issues keep their started-by fallback and are not tightened.
 */
function issueCanShow(row: ActiveWorkRow, ctx: ColdContext): boolean {
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
export const SESSION_KEEP_FIELDS = ['archived', 'agentKind', 'stoppedAt', 'agentState', 'unread', 'readAt'] as const

/** What visibility reads of a cold session, without loading the full row. */
export const COLD_SESSION_FIELDS = [...SESSION_KEEP_FIELDS, 'issueId', 'status', 'lastActiveAt'] as const

/**
 * How long a session can keep its issue shown (`sessionRetainsWorklistRow`,
 * `visibility.ts:44-70`): a shell or an archived session never
 * (`isRowSeat`); a run that never finished without limit; a finished run
 * inside its decay window; an idle finished turn inside the window counted
 * from its issue's finish.
 */
function sessionKeep(row: ActiveWorkRow): MemberKeep {
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

/**
 * The issue's rule: open and recently closed issues are active, and so is a
 * closed one a retained session, its own checkout's issueless session, its
 * unlanded branch or its closed fold can still show. Names the pool schema's
 * `sessions` (members), `worktree` (the lane, with `worktree.sessions` and
 * its `issueless` subset) and `treeParent` (the placement walk).
 */
export const ISSUE_ACTIVE_WORK = {
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
} as const satisfies UnlessShownColdSpec

/**
 * The session's rule: a bound session follows its issue (the pool schema's
 * `issue` relation); an unbound one is active until its stopped run decays.
 */
export const SESSION_ACTIVE_WORK = {
  kind: 'via',
  relation: 'issue',
  unbound: {
    dependsOn: ['issueId', ...SESSION_KEEP_FIELDS],
    predicate: (row) => row['stoppedAt'] != null || (row['agentState'] as { phase?: unknown } | undefined)?.phase === 'ended',
    shownUntil: (row) => keepDeadline(sessionKeep(row), null),
  },
  why: 'A bound session inherits its issue’s residency. An unbound stopped run is cold after the same acknowledgment/decay window its issue keeper uses.',
} as const satisfies ColdSpec

// ---------------------------------------------------------------------------
// Active work: what the first screen reads (POD-5593, review gap C3)
// ---------------------------------------------------------------------------

/** What {@link activeWork} reads: whole tables, the residency answer for each row, the clock. */
export interface ActiveWorkInput {
  /** The clock (epoch ms) every deadline is read against; `cold` must answer at the same instant. */
  readonly now: number
  readonly issues: ReadonlyMap<string, ActiveWorkRow>
  readonly sessions: ReadonlyMap<string, ActiveWorkRow>
  /** {@link coldByRule} for a row of these tables at `now`. */
  cold(entity: 'issue' | 'session', id: string): boolean
  /** The issue named in the URL, when there is one. */
  readonly opened?: string | null
}

/** The ids of the rows that are active work; every other row is history. */
export interface ActiveWork {
  readonly issues: ReadonlySet<string>
  readonly sessions: ReadonlySet<string>
}

/**
 * The first screen's rows. The residency bound ({@link coldByRule}) keeps
 * every row the list can draw; the first screen also reads, and so active
 * work also holds:
 * - every ancestor of an active issue, by the raw parent edge: nesting and
 *   placement read the parent chain, closed or archived, and an issue whose
 *   parent is missing is placed differently (its sessions then draw as
 *   orphans in their checkout's lane);
 * - the issue each active session names, with its ancestors (a session is
 *   placed by its issue);
 * - the issue named in the URL, its ancestors, its children and its
 *   sessions: what its page shows.
 * Everything else is history: the first screen answers without it. A
 * question over a whole subtree (the header's bar for the opened issue's
 * mission: progress and crew over every descendant) reads history, and
 * answers it only once history is complete.
 */
export function activeWork(input: ActiveWorkInput): ActiveWork {
  const issues = new Set<string>()
  const sessions = new Set<string>()
  // Every issue in the set has its whole chain in it, so a walk stops at
  // the first issue already there (a parent cycle included).
  const withAncestors = (id: string): void => {
    issues.add(id)
    let walk: unknown = input.issues.get(id)!['parentId']
    while (typeof walk === 'string' && input.issues.has(walk) && !issues.has(walk)) {
      issues.add(walk)
      walk = input.issues.get(walk)!['parentId']
    }
  }
  for (const id of input.issues.keys()) if (!input.cold('issue', id)) withAncestors(id)
  for (const id of input.sessions.keys()) if (!input.cold('session', id)) sessions.add(id)
  // A session is placed by the issue it names.
  for (const id of sessions) {
    const owner = input.sessions.get(id)!['issueId']
    if (typeof owner === 'string' && input.issues.has(owner) && !issues.has(owner)) withAncestors(owner)
  }
  const opened = input.opened
  if (typeof opened === 'string' && input.issues.has(opened)) {
    withAncestors(opened)
    for (const [id, row] of input.issues) if (row['parentId'] === opened) issues.add(id)
    for (const [id, row] of input.sessions) if (row['issueId'] === opened) sessions.add(id)
  }
  return { issues, sessions }
}
