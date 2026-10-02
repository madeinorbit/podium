import { z } from 'zod'
// The shared vocabulary layer (POD-1141). Imported from the LEAF module, never
// from `../entities/issue`: that import is what made the two files mutually
// dependent, and because these are zod schema VALUES evaluated at module load it
// failed at RUNTIME rather than at lint — which is why POD-367 could not compose
import {
  IssueColor,
  IssueGitState,
  IssuePanel,
  IssueSessionSummary,
  IssueStage,
  IssueType,
} from '../entities/issue-vocabulary'
import { IssueIdField, MachineIdField, RepoIdField, SessionIdField, UserIdField } from '../ids'
import { Attribution } from './attribution'
import { OpStreamDocument } from './op-stream'
import { Revision } from './primitives'

export { IssueColor, IssueGitState, IssuePanel, IssueSessionSummary, IssueStage, IssueType }

// ---------------------------------------------------------------------------
// Identity and text
// ---------------------------------------------------------------------------

/** WHICH ISSUE. `prefix`, `displayRef`, `ref` and `repoPath` are ALL DERIVED
 *  from the repo registry (D-5, D-1) and live on {@link IssueDerived} — four
 *  stored spellings of one repo-relative fact is what D-1 catalogues.
 *  `repoId` visibility is INHERITED (ADR 9 D3 rule 3). */
export const IssueIdentity = z.object({
  id: IssueIdField,
  repoId: RepoIdField.optional(),
  seq: z.number().int(),
})
export type IssueIdentity = z.infer<typeof IssueIdentity>

export const IssueConcurrency = z.object({
  revision: Revision.optional(),
})
export type IssueConcurrency = z.infer<typeof IssueConcurrency>

/**
 * THE HUMAN- AND AGENT-FACING PROSE — everything except the two op-stream
 * documents.
 *
 * `description` and `notes` are DELIBERATELY ABSENT: they are ADR 1 Amendment 1
 * D12's reserved `op-stream` members and carry {@link IssueDocuments}' shape
 * instead. Putting them here as plain strings is the shape that would have to
 * change later, which is the thing inventory §8 asks POD-365 to avoid.
 */
export const IssueText = z.object({
  title: z.string(),
  /** Technical handoff for agents; the description stays the human summary. */
  brief: z.string().optional(),
  design: z.string().optional(),
  acceptance: z.string().optional(),
  activityNotes: z.string().optional(),
  notesUpdatedAt: z.string().optional(),
  dependencyNote: z.string().optional(),
  suggestedReason: z.string().optional(),
})
export type IssueText = z.infer<typeof IssueText>

/**
 * THE TWO RESERVED `op-stream` DOCUMENTS.
 *
 * Reserved, not built — see `fields/op-stream.ts`. Both stay `field-LWW` on the
 * matrix today. What this shape buys is that the day the class is implemented is
 * not also the day the wire shape changes.
 */
export const IssueDocuments = z.object({
  description: OpStreamDocument,
  notes: OpStreamDocument.optional(),
})
export type IssueDocuments = z.infer<typeof IssueDocuments>

// ---------------------------------------------------------------------------
// Lifecycle and triage
// ---------------------------------------------------------------------------

/** WHERE IN THE PIPELINE, and how it ended. `closed`, `deferred`, `ready` and
 *  `blocked` are ALL DERIVED (D-5) and live on {@link IssueDerived} — a stored
 *  boolean beside the thing it is computed from is a second write path.
 *
 *  `deferUntil` stays here and is NOT per-user state: unlike `snoozedUntil` it
 *  is a claim about the WORK ("this cannot start before Tuesday"), identical for
 *  every viewer, and the snooze/defer split is already settled in `../clock.ts`
 *  and `../predicates/issue-stage.ts`. */
export const IssueLifecycle = z.object({
  stage: IssueStage,
  suggestedStage: IssueStage.optional(),
  closedReason: z.string().optional(),
  /** When the closed-predicate last flipped true — the stable decay anchor. */
  closedAt: z.string().optional(),
  deferUntil: z.string().optional(),
  archived: z.boolean(),
  /** Soft-delete tombstone. */
  deletedAt: z.string().optional(),
  /** WHICH PRINCIPAL closed / reopened / unblocked it (ADR 9 D5 A3).
   *
   *  Inventory §9 found this recorded ONLY on the EVENT payload
   *  (`causedBySessionId` on `issue.closed` / `reopened` / `stage_changed` /
   *  `ready`), never on the row — and CONDITIONALLY, spread on a ternary, so an
   *  operator-originated close records no attribution at all and "no actor" is
   *  today indistinguishable from "a human did it". Giving the row a home for
   *  the pair is what makes the two distinguishable; stamping it
   *  unconditionally from the transport principal is POD-367's and the command
   *  layer's. Optional here only because history has no value to backfill. */
  lastLifecycleActor: Attribution.optional(),
})
export type IssueLifecycle = z.infer<typeof IssueLifecycle>

/** PRIORITISATION AND ROUTING. `assignee` becomes a branded `UserId` (free text
 *  today, inventory §9) — ownership-adjacent rather than attribution, but the
 *  same brand. `color` is a slot NAME, never a hex ([spec:SP-b4d1]).
 *
 *  `pinned` is DELIBERATELY ABSENT: it is per-user state (inventory §7.1), and
 *  it is a SECOND pin mechanism beside the `pins` table which POD-1076 collapses. */
export const IssueTriage = z.object({
  priority: z.number().int(),
  type: IssueType,
  assignee: UserIdField.optional(),
  labels: z.array(z.string()),
  estimateMin: z.number().int().optional(),
  color: IssueColor.optional(),
  /** Fractional sort key, lexicographic ascending = top of the scope. */
  sortKey: z.string().optional(),
  dueAt: z.string().optional(),
})
export type IssueTriage = z.infer<typeof IssueTriage>

// ---------------------------------------------------------------------------
// Graph, workspace, defaults
// ---------------------------------------------------------------------------

/**
 * THE GRAPH FIELDS THAT ARE ACTUALLY STORED.
 *
 * `deps`, `dependents`, `blocksDeps` and `children` are **derived** from
 * `issue_deps` by branded id (ADR 4 D7.1) and are NOT here. `blockedByNotes` is
 * D-2's rename: it is LLM-authored prose, not the edge set.
 *
 * PRINCIPAL-DEPENDENT PROJECTION LANDS HERE FIRST (README rule 2). A parent,
 * supersede or duplicate edge may name an issue the reader cannot see; ADR 9 §3
 * O2 leaves "hide the edge, or show an opaque reference" open, per surface. Each
 * id below is therefore `.optional()` — a scoped projection can omit one without
 * this schema having to change, and an opaque-reference arm is an added member
 * on a later union rather than a reshape. Nothing here decides the policy.
 */
export const IssueGraphRefs = z.object({
  parentId: IssueIdField.optional(),
  supersededBy: IssueIdField.optional(),
  duplicateOf: IssueIdField.optional(),
  /** Renamed from `blockedBy` (D-2): prose about what is blocking, NOT edges. */
  blockedByNotes: z.array(z.string()).default([]),
})
export type IssueGraphRefs = z.infer<typeof IssueGraphRefs>

/** WHERE THE WORK HAPPENS. The same schema `GitProbeTarget` and `HandoffIssue`
 *  pick from. Visibility INHERITED — these are machine facts (ADR 9 D3 rule 3),
 *  and `machineId` is carved out of the brand flip (ADR 1 Am2 D16.2). */
export const IssueWorkspace = z.object({
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  parentBranch: z.string(),
  machineId: MachineIdField.optional(),
})
export type IssueWorkspace = z.infer<typeof IssueWorkspace>

/** Atomic destination used when a handoff moves all workspace coordinates. */
export type IssueRehomeTarget = Record<'machineId' | 'repoPath' | 'worktreePath', string>
/** WHAT THIS ISSUE'S SESSIONS LAUNCH WITH ('auto' = the agent decides).
 *  Harness-scoped defaults and per-issue overrides RESOLVE THROUGH these — that
 *  is resolution logic, not new vocabulary, and it does not belong here. */
export const IssueAgentDefaults = z.object({
  defaultAgent: z.string(),
  defaultModel: z.string(),
  defaultEffort: z.string(),
})
export type IssueAgentDefaults = z.infer<typeof IssueAgentDefaults>

// ---------------------------------------------------------------------------
// Needs-human, panel, intent, coordination, external refs
// ---------------------------------------------------------------------------

/** An outstanding question survives even when its historical asker is unknown.
 * Attribution is recorded from the authenticated caller for new commands; it is
 * never inferred from the issue's creator. `by` is an optional session delivery
 * address, so a user-authored question has attribution without that address. */
export const NeedsHuman = z.object({
  needsHuman: z.boolean(),
  asked: z
    .object({
      question: z.string(),
      options: z.array(z.string()).optional(),
      /** Historical rows may have no recorded timestamp. */
      at: z.string().optional(),
      /** Absent means there is no recorded asking session to route an answer to. */
      by: SessionIdField.optional(),
      /** Absent means unattributed; do not substitute the issue's creator. */
      attribution: Attribution.optional(),
    })
    .optional(),
})
export type NeedsHuman = z.infer<typeof NeedsHuman>

/** THE AGENT-PUBLISHED, HUMAN-FACING PANEL. Already composed today — kept as
 *  it is. `artifacts[]` is issue-OWNED detail rather than an independent
 *  entity, so it is not a D7.1 entity-in-entity embed. */
export const IssuePanelGroup = z.object({
  panel: IssuePanel.optional(),
})
export type IssuePanelGroup = z.infer<typeof IssuePanelGroup>

/** WHOSE INTENT, AND FOR WHOM. Renamed on composition (D-2) — see the file
 *  header. These are ROLE CLASSES and not principals: the CREATING principal's
 *  pair belongs on {@link Attribution}, never inferred from `intentOrigin`
 *  (inventory §9). */
export const IssueIntent = z.object({
  /** Renamed from `origin`. 'human' | 'agent'. */
  intentOrigin: z.enum(['human', 'agent']).default('human'),
  /** Who this issue is FOR. 'agent' = internal working detail, nested under its
   *  nearest human-audience ancestor. */
  audience: z.enum(['human', 'agent']).default('human'),
  /** Renamed from `draft`. A placeholder-titled vessel from the low-friction
   *  spawn flow; retitling clears it. */
  isDraftVessel: z.boolean().default(false),
})
export type IssueIntent = z.infer<typeof IssueIntent>

/** WHICH SESSIONS SPEAK FOR THIS ISSUE. Both are ACTOR-half attribution
 *  (inventory §9), branded and dangling-tolerant: the session may later be
 *  deleted, and an issue whose coordinator vanished is not an invalid issue. */
export const IssueCoordination = z.object({
  /** Designated coordinator for actionable issue-addressed mail routing.
   *  Absent = today's idle-else-most-recent heuristic. */
  coordinatorSessionId: SessionIdField.optional(),
  /** The agent session that created this issue. Absent for human creates —
   *  which is why the PAIR below is what actually answers "who started it". */
  startedBySession: SessionIdField.optional(),
  /** WHICH PRINCIPAL created it (ADR 9 D5 A3). Under D5 A4 the owner is this
   *  pair's `onBehalfOf`, never the agent. */
  createdBy: Attribution.optional(),
})
export type IssueCoordination = z.infer<typeof IssueCoordination>

/** EXTERNAL REFS. Unbranded BY DECISION: they name rows in a namespace we
 *  neither own nor mint, which is the same rule the session's workflow
 *  pass-through ids follow. */
export const IssueLinear = z.object({
  linearId: z.string().optional(),
  linearIdentifier: z.string().optional(),
  linearUrl: z.string().optional(),
  prUrl: z.string().optional(),
})
export type IssueLinear = z.infer<typeof IssueLinear>

// ---------------------------------------------------------------------------
// Derived — named here so it can be kept OUT of R1
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED reads — pure functions over R1 (ADR 4 D3.6), never stored.
 *
 * TWO THINGS THE NEXT PHASE NEEDS FROM THIS GROUP, recorded where they will be
 * read:
 *
 *   - `sessionSummary`, `childCount`, `childDoneCount` and `commentCount` are
 *     **D7.4 materialized-entity candidates** once the feed is scoped: a rollup
 *     over rows a scoped client may not hold cannot be a replica-side join
 *     (ADR 4 D7.3 as narrowed by readiness §3.1 item 4).
 *   - The same four are inventory **L-1**'s existence leak: they reveal that
 *     children, comments and sessions exist, and how many, without any of them
 *     being visible. ADR 9 §3 O1 leaves the policy open per surface; it is Phase
 *     3's (POD-290), not this file's.
 *
 * `sessions: SessionMeta[]` is **not here and must not be added**. It is THE
 * entity-in-entity embed ADR 4 D7's normalization law deletes — O(world) per
 * change with one user, O(world × N) with N users each holding a different
 * slice, and a nested child cannot be independently suppressed from a scoped
 * feed. POD-367 replaces it with `sessionIds` or a replica-side join over the
 * slice.
 */
export const IssueDerived = z.object({
  ready: z.boolean().optional(),
  blocked: z.boolean().optional(),
  deferred: z.boolean().optional(),
  childCount: z.number().int().nonnegative().optional(),
  childDoneCount: z.number().int().nonnegative().optional(),
  commentCount: z.number().int().nonnegative().optional(),
  sessionSummary: IssueSessionSummary.optional(),
  gitState: IssueGitState.optional(),
  /** From the repo registry + `seq`. Four stored spellings collapse here (D-1). */
  displayRef: z.string().optional(),
  prefix: z.string().optional(),
  repoPath: z.string().optional(),
  /** From the READER's per-user `readAt` — per-principal, like the session's. */
  unread: z.boolean().optional(),
})
export type IssueDerived = z.infer<typeof IssueDerived>
