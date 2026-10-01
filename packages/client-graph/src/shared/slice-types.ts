/**
 * POD-4442 — the frozen worklist slice all three round-two arms build.
 *
 * Three entity types, four relations, eight rules, three components; see
 * docs/plans/pod-4441-round-two-slice.md (the spec; the oracle checks against
 * it). Every section below cites the spec section it implements — code that
 * cannot cite the spec does not belong in shared/.
 *
 * OWNERSHIP. shared/ is owned by the slice spec (POD-4442). Arms may read it;
 * changing it needs the coordinator (POD-4286 session A), because every arm,
 * the fixture, the oracle and the harness build against these exact shapes.
 * No imports from the legacy view-model, slice, mission, presentation or
 * replica view code — that repeats round one and fails the H4 shape review.
 */

export interface SliceDepEdge {
  id: string
  type: string
}

/**
 * One issue: the wire row joined with its projection row by id (spec §1).
 * The projection is a separate replica kind (`issueProjections`) carrying the
 * issue's own durable fields; the wire row carries the per-user cursor
 * (`readAt`) and the repo join goes through the worktree's prefix. Arms hold
 * both spellings; the join key is always `id`.
 */
export interface SliceIssue {
  id: string
  parentId?: string | null
  /** Immutable creation order key, newest first (spec §3 R-ORDER). */
  seq: number
  createdAt: string
  updatedAt: string
  closedAt?: string | null
  deletedAt?: string | null
  archived?: boolean
  stage: string
  closedReason?: string | null
  audience?: 'human' | 'agent'
  draft?: boolean
  /** Pinned issues move out of their group into the PINNED section (spec §3 R-GROUP). */
  pinned?: boolean
  /** Persisted manual key, meaningful only against siblings (spec §3 R-ORDER). */
  sortKey?: string | null
  deferUntil?: string | null
  /** Server-state dismissal into the closed fold (spec §3 R-GROUP). */
  tuckedAt?: string | null
  repoId?: string | null
  repoPath: string
  worktreePath?: string | null
  coordinatorSessionId?: string | null
  startedBySession?: string | null
  /** Outgoing edges; the `discovered-from` one names the spin-off origin (spec §3 R-ORIGIN). */
  deps?: SliceDepEdge[]
  needsHuman?: boolean
  blocked?: boolean
  readAt?: string | null
  unread?: boolean
  title: string
  linearIdentifier?: string
  color?: string | null
  branch?: string | null
  parentBranch?: string | null
  gitState?: { shared?: boolean; merged?: boolean; ahead?: number; [key: string]: unknown } | null
  commentCount?: number
  origin?: 'human' | 'agent'
  humanQuestion?: string | null
  humanQuestionOptions?: readonly string[]
  supersededBy?: string | null
  duplicateOf?: string | null
  /** Declared small summary over the raw normalized session lane (resume
   * twins can disappear from the roster while still contributing unread). */
  sessionFacts?: { replicaActivityAt?: string; tipActivityAt?: string; staffed?: boolean }
}

export interface SliceAgentState {
  phase?: string | null
  since?: string
  workingMsTotal?: number
  nativeSubagentCount?: number
  idle?: { kind?: string; summary?: string }
  error?: { class?: string; retryable?: boolean }
}

/**
 * One session (spec §1). A session with a `worktreePath`-resolvable `cwd` but
 * no `issueId` is owned by longest-prefix containment, never orphaned
 * (spec §2 R3).
 */
export interface SliceSession {
  sessionId: string
  issueId?: string | null
  cwd: string
  agentKind?: string | null
  title?: string
  createdAt?: string
  name?: string | null
  displayRef?: string
  snoozedUntil?: string | null
  draftUpdatedAt?: string
  headless?: boolean
  status?: string | null
  archived?: boolean
  lastActiveAt: string
  stoppedAt?: string | null
  readAt?: string | null
  unread?: boolean
  agentState?: SliceAgentState
  /** Standing offer; only its `createdAt` participates in the slice (waiting-age anchor). */
  offer?: { createdAt?: string } | null
  /** Native resume ref. Sessions sharing one collapse per `dedupeSessionsByResume` (POD-4551). */
  resume?: { kind: string; value: string }
}

/**
 * One repo/worktree lane (spec §1). Carries the repo facts the slice needs —
 * grouping key, label and the `displayRef` prefix join — so arms never read
 * the repo collection directly.
 */
export interface SliceWorktree {
  path: string
  repoId?: string | null
  repoPath: string
  repoName: string
  /** Repo prefix for `displayRef`; null/undefined renders `#seq`. */
  prefix?: string | null
  branch?: string
  isMain?: boolean
  projectIndex?: number
  projectRoot?: boolean
  projectAliases?: readonly string[]
}

/**
 * Locals (spec §5). Selection is a local, never a row field; the coarse clock
 * is data, never `Date.now()`. Arms receive them through a `LocalsSource`
 * (`arm.ts`, POD-4608), never as a value fixed at creation.
 */
export interface SliceLocals {
  selectedIssueId: string | null
  /** Whether the selected row was inside the closed fold when clicked (lane latch). */
  selectedIssueWasFolded?: boolean
  /** Epoch ms. Arms re-derive time-dependent outputs only from this value. */
  coarseNow: number
}

/** One local, as a `LocalsSource` notification names it. */
export type LocalsKey = keyof SliceLocals

/** Every local, in declaration order. The selection keys are the first two. */
export const LOCALS_KEYS: readonly LocalsKey[] = [
  'selectedIssueId',
  'selectedIssueWasFolded',
  'coarseNow',
]

/** Row motion phase (spec §3 R-SUM): waiting dominates, then working. */
export type SlicePhase = 'queued' | 'working' | 'waiting' | 'done'

/**
 * One derived worklist row (spec §3 R-SUM, §7 oracle projection). The
 * comparison surface: the parity oracle checks exactly these fields.
 */
export interface SliceRow {
  id: string
  displayRef: string
  title: string
  phase: SlicePhase
  progressDone: number
  progressTotal: number
  /** An agent on this row is computing right now (spec §3 R-SUM). */
  working: boolean
  /** This row asks the operator for something (waiting sessions + pending decisions). */
  asking: boolean
  /** Order band: 0 pinned/returned, 1 middle, 2 snoozed (spec §3 R-ORDER). */
  band: 0 | 1 | 2
  /** `repoId ?? repoPath` (spec §3 R-GROUP). */
  repoKey: string
  /** Inside its group's closed fold (spec §3 R-GROUP). */
  closed: boolean
}

/**
 * One project group (spec §3 R-GROUP). `rowIds` are the open lanes in order
 * (snoozed-band rows included — the snoozed disclosure is outside the slice's
 * three components); `closedIds` is the per-group closed fold, newest tucked
 * (or finished) first.
 */
export interface SliceGroup {
  key: string
  label: string
  rowIds: string[]
  closedIds: string[]
}

/** The ordered list: pinned section first, then groups (spec §3 R-ORDER, R-GROUP). */
export interface SliceOrder {
  pinnedIds: string[]
  groups: SliceGroup[]
}

/** The whole slice output (spec §7): order plus rows by id. */
export interface SliceSnapshot {
  order: SliceOrder
  rowsById: Record<string, SliceRow>
}
