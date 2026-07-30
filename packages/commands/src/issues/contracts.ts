/**
 * THE SIXTY-EIGHT ISSUE COMMAND CONTRACTS (POD-311, ADR 3 D1).
 *
 * The issue tracker is this package's FOURTH tenant and its hardest, because it is
 * the surface every agent in the POD-279 fan-out is using while this migration runs.
 * So the standard here is not "a good contract table" — it is ZERO BEHAVIOUR CHANGE.
 * Every field below is a transcription of what `apps/server/src/modules/issues/
 * registry.ts` already declared, and where the shipped rule is odd (see `mailClaim`
 * and `linearSearch`) the oddity is CARRIED and explained rather than tidied away.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED HERE, AND WHAT DELIBERATELY DID NOT
 * ---------------------------------------------------------------------------
 *
 * MOVED (L1 — this file): the wire name, the version, the input SCHEMA INSTANCE, the
 * ADR 3 policy/exposure/delivery/redaction facets and the Amendment 1
 * ownership/attribution/error-consistency columns.
 *
 * The schemas moved rather than being re-declared, and that distinction is the whole
 * migration: `registry.ts` now IMPORTS these instances and the join asserts `toBe`
 * against them. A restatement — the same field list typed out twice — would parse
 * identically, encode identically and pass every golden wire fixture, because
 * branding is compile-time. Object identity is the only instrument that sees the
 * fork, which is why the join is checked with `toBe` and not `toEqual`.
 *
 * STAYED (L3 — `modules/issues/registry.ts`): the handler, the `kind` (which tRPC
 * procedure type it mounts as — a transport fact, not a contract one), and the
 * `target` extractor. The extractor stays because it reads RAW, unparsed input and
 * feeds two server-side mechanisms — the capability guard and the viaHub forwarding
 * detection — neither of which is a contract concern. What is enforced across the
 * seam is the BICONDITIONAL: `policy.resource === 'issue'` if and only if the handler
 * declares a `target`. That partition is asserted, not trusted, in exactly the way
 * the workflows tenant asserts its `advance` partition — so "this command has no
 * existing target" and "I forgot the extractor" cannot look alike.
 *
 * ---------------------------------------------------------------------------
 * THE SIX CLASSES
 * ---------------------------------------------------------------------------
 *
 *   READS (24)                  role-gated only, never subtree-gated
 *   PER-USER STATE (4)          markRead · markUnread · setTucked · mailInbox
 *   SUBTREE-SCOPED WRITES (29)  mutate an existing issue, `--outside-scope` escape
 *   MANAGE (3)                  delete · restore · setLabels
 *   ADDITIVE WRITES (6)         create · attachSession · mailSend · subscription*
 *   THE TWO THAT ARE THEIR OWN CLASS  linearSearch · mailClaim (see each)
 *
 * The class cells live in `cells.ts`; the reasoning is written once there rather than
 * sixty-eight times here.
 *
 * DO NOT COPY THE PER-USER FOUR ONTO A NEW COMMAND WITHOUT READING
 * {@link PER_USER_VISIBILITY}. Those four are the only contracts on this surface
 * whose declared class is currently STRONGER than the storage under it, and
 * `per-user-singletons.tripwire.test.ts` pins the divergence so that whoever re-keys
 * the columns is told by a red test rather than left to discover a stale contract.
 * The named trap is theirs alone — a warning on all sixty-eight would be a warning on
 * none, which is POD-731's lesson from `workflows.assign`.
 */

import {
  IssueColor,
  IssueIdField,
  IssueStage,
  IssueType,
  isSortKey,
  SessionIdField,
  UserIdField,
} from '@podium/model'
import { z } from 'zod'
import type { CommandContract } from '../contract'
import {
  ADDITIVE_POLICY,
  CREATES_NOTHING,
  ISSUE_ATTRIBUTION,
  ISSUE_REDACTION,
  ISSUE_VISIBILITY,
  MANAGE_POLICY,
  owns,
  PER_USER_DELIVERY,
  PER_USER_POLICY,
  PER_USER_VISIBILITY,
  READ_DELIVERY,
  READ_POLICY,
  REAUTHORIZATION,
  SERVED_EVERYWHERE,
  SERVED_ON_WIRE,
  TARGETED_ERRORS,
  UNTARGETED_ERRORS,
  WRITE_DELIVERY,
  WRITE_POLICY,
} from './cells'

// ---------------------------------------------------------------------------
// Shared input fragments — the SAME two the shipped registry used, moved verbatim
// so the cutover is a move and not a re-specification.
// ---------------------------------------------------------------------------

const repoScoped = z.object({ repoPath: z.string().optional() })
const byId = z.object({ id: z.string() })

// ---------------------------------------------------------------------------
// THE INPUT SCHEMAS — moved from `registry.ts`, byte-for-byte where they were
// literals and by alias where they were the shared fragments above. These are the
// instances every transport parses with; nothing re-declares them.
// ---------------------------------------------------------------------------

export const listInput = repoScoped

export const primeInput = repoScoped.optional()

export const readyInput = repoScoped

export const blockedInput = repoScoped

export const graphInput = repoScoped

export const epicStatusInput = byId

export const childrenInput = z.object({ id: z.string(), recursive: z.boolean().optional() })

export const treeInput = byId

export const depReportInput = z.object({ id: z.string().optional(), repoPath: z.string().optional() })

export const closeEligibleEpicsInput = repoScoped

export const findDuplicatesInput = z.object({ repoPath: z.string().optional(), threshold: z.number().optional() })

export const staleInput = z.object({ repoPath: z.string().optional(), days: z.number().optional() })

export const lintInput = repoScoped

export const doctorInput = repoScoped

export const preflightInput = repoScoped

export const searchInput = z.object({
  repoPath: z.string().optional(),
  text: z.string().optional(),
  status: z.enum(['open', 'closed', 'ready', 'blocked', 'deferred']).optional(),
  stage: IssueStage.optional(),
  priority: z.number().int().optional(),
  type: IssueType.optional(),
  assignee: UserIdField.optional(),
  label: z.string().optional(),
  parentId: IssueIdField.optional(),
})

export const countInput = repoScoped

export const statsInput = repoScoped

export const orphansInput = z.object({ repoPath: z.string() })

export const getInput = byId

export const commentsInput = byId

export const eventsInput = z.object({
  since: z.number().int().min(0).default(0),
  kinds: z.array(z.string()).optional(),
  repoPath: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
})

export const linearSearchInput = z.object({ query: z.string() })

export const setStateInput = z.object({ id: z.string(), text: z.string() })

export const panelApplyInput = z.object({
  id: z.string(),
  op: z.enum([
    'todo-add',
    'todo-done',
    'todo-undone',
    'todo-remove',
    'todo-clear',
    'artifact-add',
    'artifact-remove',
    'deferred-add',
    'deferred-remove',
  ]),
  text: z.string().optional(),
  index: z.number().int().min(1).optional(),
  path: z.string().optional(),
  title: z.string().optional(),
  /** Extra file paths bundled with `path` into one artifact snapshot ([spec:SP-0fc9]). */
  extraPaths: z.array(z.string()).optional(),
})

export const createInput = z.object({
  repoPath: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  brief: z.string().optional(),
  parentBranch: z.string().optional(),
  defaultAgent: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
  machineId: z.string().optional(),
  startNow: z.boolean(),
  linear: z
    .object({ id: z.string().optional(), identifier: z.string(), url: z.string() })
    .optional(),
  priority: z.number().int().min(0).max(4).optional(),
  type: IssueType.optional(),
  assignee: UserIdField.optional(),
  labels: z.array(z.string()).optional(),
  parentId: IssueIdField.optional(),
  // Colour slot name [spec:SP-b4d1]; absent = no colour (slate flow).
  color: IssueColor.optional(),
  // #198: an agent opts a work item onto the human's top-level board with
  // `audience: 'human'`. `origin` is NOT accepted — it is derived from the
  // caller (operator vs constrained agent), so provenance cannot be forged.
  audience: z.enum(['human', 'agent']).optional(),
  mutationId: z.string().max(128).optional(),
})

export const startInput = z.object({
  id: z.string(),
  agentKind: z.string().optional(),
  forceUnknownModel: z.boolean().optional(),
})

export const updateInput = z.object({
  id: IssueIdField,
  patch: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    brief: z.string().optional(),
    stage: IssueStage.optional(),
    parentBranch: z.string().optional(),
    defaultAgent: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultEffort: z.string().optional(),
    machineId: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    priority: z.number().int().min(0).max(4).optional(),
    type: IssueType.optional(),
    assignee: UserIdField.optional(),
    parentId: IssueIdField.optional(),
    design: z.string().optional(),
    acceptance: z.string().optional(),
    notes: z.string().optional(),
    dueAt: z.string().optional(),
    deferUntil: z.string().optional(),
    closedReason: z.string().optional(),
    pinned: z.boolean().optional(),
    // Manual order (POD-168): fractional key, validated so a malformed key
    // can never poison a sibling scope's ordering.
    sortKey: z.string().max(128).refine(isSortKey, 'malformed sort key').optional(),
    // Colour slot name [spec:SP-b4d1]; null clears back to the slate flow.
    color: IssueColor.nullable().optional(),
    estimateMin: z.number().int().optional(),
  }),
  mutationId: z.string().max(128).optional(),
})

export const promoteInput = z.object({ id: z.string() })

export const attachSessionInput = z.object({
  sessionId: SessionIdField,
  targetId: z.string().optional(),
  confirmRehome: z.boolean().optional(),
  // #348 [spec:SP-a859]: no caller-supplied `origin` — provenance is derived
  // from the caller below, exactly like issues.create, so it cannot be forged.
  newSubissue: z.object({ title: z.string().min(1) }).optional(),
  // POD-85: spinoff = top-level issue + discovered-from edge to the origin.
  newSpinoff: z.object({ title: z.string().min(1) }).optional(),
})

export const archiveInput = byId

export const deleteInput = byId

export const restoreInput = byId

export const actionInput = z.object({ id: z.string(), kind: z.enum(['rebase', 'pr', 'merge']) })

export const cleanupInput = byId

export const stopInput = z.object({
  id: z.string(),
  force: z.boolean().optional(),
})

export const integrateInput = byId

export const addSessionInput = z.object({
  id: z.string(),
  agentKind: z.string().optional(),
  forceUnknownModel: z.boolean().optional(),
})

export const addShellInput = byId

export const applySuggestionInput = byId

export const dismissSuggestionInput = byId

export const refreshAssistantInput = byId

export const setLabelsInput = z.object({ id: z.string(), labels: z.array(z.string()) })

export const addCommentInput = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string().min(1),
  mutationId: z.string().max(128).optional(),
})

export const depAddInput = z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() })

export const depRemoveInput = z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() })

export const deferInput = z.object({ id: z.string(), until: z.string().nullable() })

export const undeferInput = byId

export const markReadInput = z.object({ id: z.string(), mutationId: z.string().max(128).optional() })

export const markUnreadInput = z.object({ id: z.string(), mutationId: z.string().max(128).optional() })

export const setTuckedInput = z.object({
  id: z.string(),
  tucked: z.boolean(),
  mutationId: z.string().max(128).optional(),
})

export const setNeedsHumanInput = z.object({
  id: z.string(),
  question: z.string().optional(),
  // Structured question metadata (issue #53): suggested answers rendered as
  // Tray chips + the asking session (defaults to the caller's own session).
  options: z.array(z.string().min(1)).max(20).optional(),
  askedBy: SessionIdField.optional(),
})

export const answerQuestionInput = z.object({ id: z.string(), answer: z.string().trim().min(1) })

export const clearNeedsHumanInput = byId

export const reparentInput = z.object({ id: z.string(), parentId: z.string().nullable() })

export const claimInput = z.object({ id: z.string(), assignee: UserIdField })

export const setCoordinatorInput = z.object({
  id: z.string(),
  /** Explicit session id to set; null clears. Mutually exclusive with claim. */
  sessionId: SessionIdField.nullable().optional(),
  /** When true, set coordinator to the calling session (actorSessionId). */
  claim: z.boolean().optional(),
})

export const closeInput = z.object({
  id: z.string(),
  reason: z.string().optional(),
  mutationId: z.string().max(128).optional(),
})

export const supersedeInput = z.object({ oldId: z.string(), newId: z.string() })

export const duplicateInput = z.object({ id: z.string(), canonicalId: z.string() })

export const mailSendInput = z.object({ id: z.string(), body: z.string().min(1) })

export const mailInboxInput = z.object({ id: z.string().optional() }).optional()

export const mailClaimInput = z.object({ messageId: z.string() })

export const mailPendingInput = z.object({ id: z.string().optional() }).optional()

export const subscriptionAddInput = z.object({
  event: z.string().min(1),
  source: z.object({
    kind: z.enum(['relationship', 'issue', 'session']),
    ref: z.string().min(1),
  }),
  deliver: z
    .object({ nudge: z.boolean().optional(), notify: z.boolean().optional() })
    .optional(),
  // Operator-only (#129 Phase C): the Automations UI creates a subscription for an
  // explicit subscriber (which issue/session to notify). Ignored for constrained
  // agents, who always subscribe themselves via deriveSubscriber.
  subscriber: z.object({ kind: z.enum(['session', 'issue']), id: z.string() }).optional(),
})

export const subscriptionRemoveInput = byId

export const subscriptionSetEnabledInput = z.object({ id: z.string(), enabled: z.boolean() })

export const subscriptionListInput = z.void()


// -------------------------------------------------------------------------
// READS — 24 queries, role-gated only
// -------------------------------------------------------------------------

export const issueListContract = {
  name: 'issues.list',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: listInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issuePrimeContract = {
  name: 'issues.prime',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: primeInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueReadyContract = {
  name: 'issues.ready',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: readyInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueBlockedContract = {
  name: 'issues.blocked',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: blockedInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueGraphContract = {
  name: 'issues.graph',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: graphInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueEpicStatusContract = {
  name: 'issues.epicStatus',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: epicStatusInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueChildrenContract = {
  name: 'issues.children',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: childrenInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueTreeContract = {
  name: 'issues.tree',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: treeInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueDepReportContract = {
  name: 'issues.depReport',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: depReportInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueCloseEligibleEpicsContract = {
  name: 'issues.closeEligibleEpics',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: closeEligibleEpicsInput,
  policy: READ_POLICY,
  exposure: SERVED_ON_WIRE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueFindDuplicatesContract = {
  name: 'issues.findDuplicates',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: findDuplicatesInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueStaleContract = {
  name: 'issues.stale',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: staleInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueLintContract = {
  name: 'issues.lint',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: lintInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueDoctorContract = {
  name: 'issues.doctor',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: doctorInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issuePreflightContract = {
  name: 'issues.preflight',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: preflightInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSearchContract = {
  name: 'issues.search',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: searchInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueCountContract = {
  name: 'issues.count',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: countInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueStatsContract = {
  name: 'issues.stats',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: statsInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueOrphansContract = {
  name: 'issues.orphans',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: orphansInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueGetContract = {
  name: 'issues.get',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: getInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueCommentsContract = {
  name: 'issues.comments',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: commentsInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueEventsContract = {
  name: 'issues.events',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: eventsInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

export const issueMailPendingContract = {
  name: 'issues.mailPending',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: mailPendingInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSubscriptionListContract = {
  name: 'issues.subscriptionList',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: subscriptionListInput,
  policy: READ_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: READ_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

// -------------------------------------------------------------------------
// PER-USER STATE — the four that write ADR 1’s `issueMessageReadAt` row
// -------------------------------------------------------------------------

export const issueMarkReadContract = {
  name: 'issues.markRead',
  version: 1,
  visibility: PER_USER_VISIBILITY,
  input: markReadInput,
  policy: PER_USER_POLICY,
  exposure: SERVED_ON_WIRE,
  delivery: PER_USER_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueMarkUnreadContract = {
  name: 'issues.markUnread',
  version: 1,
  visibility: PER_USER_VISIBILITY,
  input: markUnreadInput,
  policy: PER_USER_POLICY,
  exposure: SERVED_ON_WIRE,
  delivery: PER_USER_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSetTuckedContract = {
  name: 'issues.setTucked',
  version: 1,
  visibility: PER_USER_VISIBILITY,
  input: setTuckedInput,
  policy: PER_USER_POLICY,
  exposure: SERVED_ON_WIRE,
  delivery: PER_USER_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueMailInboxContract = {
  name: 'issues.mailInbox',
  version: 1,
  visibility: PER_USER_VISIBILITY,
  input: mailInboxInput,
  policy: PER_USER_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: PER_USER_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

// -------------------------------------------------------------------------
// SUBTREE-SCOPED WRITES — 29 commands that mutate an EXISTING issue
// -------------------------------------------------------------------------

export const issueSetStateContract = {
  name: 'issues.setState',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: setStateInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issuePanelApplyContract = {
  name: 'issues.panelApply',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: panelApplyInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['artifact'], 'parent', 
        'The `artifact-add` op snapshots files onto the issue, and ADR 1\'s `artifacts` row inherits ' +
        'whatever it hangs on — here, the issue. The todo and deferred ops mint nothing; the row is ' +
        'declared for the union because a contract states what the command CAN create.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueStartContract = {
  name: 'issues.start',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: startInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['session'], 'parent', 
        'Starting work mints a session bound to the issue; readiness §3.1.2 makes the session inherit the ' +
        'ISSUE, not the agent that started it. The session\'s own `use` decision on the machine is the ' +
        'sessions feature\'s contract, not this one.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueUpdateContract = {
  name: 'issues.update',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: updateInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issuePromoteContract = {
  name: 'issues.promote',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: promoteInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueArchiveContract = {
  name: 'issues.archive',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: archiveInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueActionContract = {
  name: 'issues.action',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: actionInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueCleanupContract = {
  name: 'issues.cleanup',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: cleanupInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueStopContract = {
  name: 'issues.stop',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: stopInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueIntegrateContract = {
  name: 'issues.integrate',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: integrateInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueAddSessionContract = {
  name: 'issues.addSession',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: addSessionInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['session'], 'parent', 'As `start`: the new session inherits the ISSUE it is added to, never the caller.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueAddShellContract = {
  name: 'issues.addShell',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: addShellInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['session'], 'parent', 'As `start`: the shell session inherits the ISSUE it is added to, never the caller.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueApplySuggestionContract = {
  name: 'issues.applySuggestion',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: applySuggestionInput,
  policy: WRITE_POLICY,
  exposure: SERVED_ON_WIRE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueDismissSuggestionContract = {
  name: 'issues.dismissSuggestion',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: dismissSuggestionInput,
  policy: WRITE_POLICY,
  exposure: SERVED_ON_WIRE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueRefreshAssistantContract = {
  name: 'issues.refreshAssistant',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: refreshAssistantInput,
  policy: WRITE_POLICY,
  exposure: SERVED_ON_WIRE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueAddCommentContract = {
  name: 'issues.addComment',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: addCommentInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['issue-comment'], 'parent', 
        'A comment inherits its ISSUE\'s owner and grants — ADR 1\'s `issueComments` row inherits ' +
        '`issueCore` — not the commenter\'s. Otherwise a shared issue would fragment into per-commenter ' +
        'ownership one reply at a time. The caller-supplied `author` is display text, not the owner.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueDepAddContract = {
  name: 'issues.depAdd',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: depAddInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueDepRemoveContract = {
  name: 'issues.depRemove',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: depRemoveInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueDeferContract = {
  name: 'issues.defer',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: deferInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueUndeferContract = {
  name: 'issues.undefer',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: undeferInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSetNeedsHumanContract = {
  name: 'issues.setNeedsHuman',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: setNeedsHumanInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueAnswerQuestionContract = {
  name: 'issues.answerQuestion',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: answerQuestionInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueClearNeedsHumanContract = {
  name: 'issues.clearNeedsHuman',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: clearNeedsHumanInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueReparentContract = {
  name: 'issues.reparent',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: reparentInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueClaimContract = {
  name: 'issues.claim',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: claimInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSetCoordinatorContract = {
  name: 'issues.setCoordinator',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: setCoordinatorInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueCloseContract = {
  name: 'issues.close',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: closeInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSupersedeContract = {
  name: 'issues.supersede',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: supersedeInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueDuplicateContract = {
  name: 'issues.duplicate',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: duplicateInput,
  policy: WRITE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

// -------------------------------------------------------------------------
// MANAGE — 3 commands that need the manage verb
// -------------------------------------------------------------------------

export const issueDeleteContract = {
  name: 'issues.delete',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: deleteInput,
  policy: MANAGE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueRestoreContract = {
  name: 'issues.restore',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: restoreInput,
  policy: MANAGE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSetLabelsContract = {
  name: 'issues.setLabels',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: setLabelsInput,
  policy: MANAGE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

// -------------------------------------------------------------------------
// ADDITIVE / SELF-ADDRESSED WRITES — 6 with no existing-issue target
// -------------------------------------------------------------------------

export const issueCreateContract = {
  name: 'issues.create',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: createInput,
  policy: ADDITIVE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['issue'], 'on-behalf-of-human', 
        'A new issue is owned by the creating principal\'s on-behalf-of human — ADR 1\'s `issueCore` row, ' +
        'whose `inheritanceOnCreate` is DECLARED `on-behalf-of-human` because a top-level issue has no ' +
        'parent to inherit from. A `parentId` makes a sub-issue, which ADR 1 records as a graph EDGE and ' +
        'not a containment, so the parent does not become the owner.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueAttachSessionContract = {
  name: 'issues.attachSession',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: attachSessionInput,
  policy: ADDITIVE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['issue'], 'parent', 
        'Attaching may MINT an issue: `newSubissue` files one under the target and it inherits that ' +
        'issue; `newSpinoff` files a top-level one carrying only a `discovered-from` edge. `origin` is ' +
        'derived from the caller and never accepted from payload ([spec:SP-a859]), so the provenance ' +
        'stamped on the new row cannot be forged.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueMailSendContract = {
  name: 'issues.mailSend',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: mailSendInput,
  policy: ADDITIVE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['issue-message'], 'parent', 
        'A message inherits the issue it is addressed to (ADR 1\'s `issueMessages` inherits `issueCore`). ' +
        'The SENDER is the attribution pair, stamped by `messageSender()` from the capability — a ' +
        'different fact from ownership, and the one that must not be substituted for it.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSubscriptionAddContract = {
  name: 'issues.subscriptionAdd',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: subscriptionAddInput,
  policy: ADDITIVE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: owns(['event-subscription'], 'on-behalf-of-human', 
        'A subscription belongs to its SUBSCRIBER, which for a constrained agent is always itself: ' +
        '`deriveSubscriber()` resolves the caller\'s own session or subtree root, and an agent-supplied ' +
        '`subscriber` is ignored rather than refused. Only the operator may name someone else\'s.'),
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSubscriptionRemoveContract = {
  name: 'issues.subscriptionRemove',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: subscriptionRemoveInput,
  policy: ADDITIVE_POLICY,
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

export const issueSubscriptionSetEnabledContract = {
  name: 'issues.subscriptionSetEnabled',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: subscriptionSetEnabledInput,
  policy: ADDITIVE_POLICY,
  exposure: SERVED_ON_WIRE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract


// ---------------------------------------------------------------------------
// THE TWO THAT ARE THEIR OWN CLASS
//
// Both are shipped oddities. Neither is tidied here: a migration that "fixes" a
// surprising rule while claiming zero behaviour change is a migration whose diff
// nobody can trust. Both are recorded, and both are pinned by the audit.
// ---------------------------------------------------------------------------

/**
 * `linearSearch` — A QUERY THAT REQUIRES WRITE AUTHORITY, and the shipped registry
 * says so in one line with no comment: `kind: 'query'`, `action: 'write'`.
 *
 * It is not a mistake and it is not a read. The command reaches OUT to Linear's API
 * with the instance's credentials, so what it costs is not "look at a row you may
 * already see" but "spend this deployment's third-party quota and put its token in
 * front of a caller-supplied query string". `write` is the honest floor for that, and
 * a viewer-grade caller is refused. That is why the facet pair looks contradictory:
 * `kind` is a TRANSPORT fact (which tRPC procedure type it mounts as, and it mounts
 * as a query because it mutates no Podium row), while `action` is an AUTHORITY fact.
 * They are allowed to disagree and here they must.
 *
 * `resource: 'none'` because there is no Podium row to scope against — the target is
 * an external system. `SERVED_ON_WIRE`: no CLI verb and no MCP tool reaches it; the
 * web UI's Linear import dialog is the only caller.
 */
export const issueLinearSearchContract = {
  name: 'issues.linearSearch',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: linearSearchInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'A QUERY THAT NEEDS WRITE AUTHORITY, carried verbatim from the shipped table (`kind: query`, ' +
      '`action: write`). It spends the deployment’s Linear credential and quota on a caller-supplied ' +
      'query string, which is a write-grade act even though no Podium row changes — so a viewer is ' +
      'refused. `kind` is a transport fact and `action` an authority one; disagreeing is correct here. ' +
      '`resource: none` because the target is an external system with no row to scope against.',
  },
  exposure: SERVED_ON_WIRE,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never queued. The call is a live round trip to a third-party API; a replay would re-spend quota ' +
      'to answer a question whose asker is long gone, and there is no local effect to reconcile.',
    applyTimeReauthorization: REAUTHORIZATION,
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The query string is the caller’s own search text and the results are Linear issue summaries the ' +
      'caller asked for. The CREDENTIAL never appears on this contract’s input or output — it is the ' +
      'server’s, read from configuration, and is why the action is `write` rather than `read`.',
  },
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: UNTARGETED_ERRORS,
} as const satisfies CommandContract

/**
 * `mailClaim` — DECLARES A SUBTREE SCOPE AND THEN DEFEATS THE MIDDLEWARE'S GATE ON
 * PURPOSE, so that the handler can run the same gate against a target the middleware
 * could not have known.
 *
 * The shipped def is `scope: 'issue'` with `target: () => undefined`. Read quickly
 * that looks like a hole. It is the opposite. The input names a MESSAGE id, not an
 * issue id; the issue to gate against is the message's `issueId`, which is only
 * discoverable by loading the message. So the extractor returns `undefined` — the
 * middleware skips a check it would have had to guess at — and the handler resolves
 * the message and calls the SAME `checkIssueAccess` with the real issue id. One gate,
 * moved to where its argument exists, not a gate skipped.
 *
 * `policy.resource` is therefore `'issue'`: the authority this command answers to IS
 * an issue's, and declaring `none` would say the opposite of what the handler does.
 * The seam biconditional (`resource: 'issue'` iff a `target` extractor exists) still
 * holds — the extractor exists, and returning `undefined` is a value it returns, not
 * an extractor it lacks. That distinction is exactly why the biconditional is written
 * over the PRESENCE of the extractor and not over the value it happens to produce,
 * and `audit-issue-commands.ts` plants a fixture that removes the extractor entirely
 * to prove the check can say NO.
 *
 * A message the caller may not reach fails NOT_FOUND, identically to an unknown
 * message id — D20.2, and the shipped handler already throws exactly that.
 */
export const issueMailClaimContract = {
  name: 'issues.mailClaim',
  version: 1,
  visibility: ISSUE_VISIBILITY,
  input: mailClaimInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'issue',
    confirmation: 'confirm',
    rationale:
      'Claiming a mail message is a write against the message’s OWNING ISSUE, and the id on the input ' +
      'names the message rather than that issue. So the middleware’s extractor deliberately returns ' +
      '`undefined` — it cannot know the target without loading the row — and the handler runs the same ' +
      '`checkIssueAccess` once it has. The gate is MOVED to where its argument exists, not skipped, ' +
      'which is why the resource is `issue` and not `none`. Carried verbatim from the shipped def.',
  },
  exposure: SERVED_EVERYWHERE,
  delivery: WRITE_DELIVERY,
  redaction: ISSUE_REDACTION,
  ownership: CREATES_NOTHING,
  attribution: ISSUE_ATTRIBUTION,
  errorConsistency: TARGETED_ERRORS,
} as const satisfies CommandContract

// ---------------------------------------------------------------------------
// THE TABLE
//
// Keyed by the BARE proc name every transport already dispatches on (`list`,
// `close`, `mailSend`, …). The wire names are kept: renaming one is a client
// compatibility change and this is a migration, not a rename. The contract's own
// dotted `name` (`issues.close`) is the identity the classification lint and the
// audit read.
// ---------------------------------------------------------------------------

export const ISSUE_CONTRACTS = {
  action: issueActionContract,
  addComment: issueAddCommentContract,
  addSession: issueAddSessionContract,
  addShell: issueAddShellContract,
  answerQuestion: issueAnswerQuestionContract,
  applySuggestion: issueApplySuggestionContract,
  archive: issueArchiveContract,
  attachSession: issueAttachSessionContract,
  blocked: issueBlockedContract,
  children: issueChildrenContract,
  claim: issueClaimContract,
  cleanup: issueCleanupContract,
  clearNeedsHuman: issueClearNeedsHumanContract,
  close: issueCloseContract,
  closeEligibleEpics: issueCloseEligibleEpicsContract,
  comments: issueCommentsContract,
  count: issueCountContract,
  create: issueCreateContract,
  defer: issueDeferContract,
  delete: issueDeleteContract,
  depAdd: issueDepAddContract,
  depRemove: issueDepRemoveContract,
  depReport: issueDepReportContract,
  dismissSuggestion: issueDismissSuggestionContract,
  doctor: issueDoctorContract,
  duplicate: issueDuplicateContract,
  epicStatus: issueEpicStatusContract,
  events: issueEventsContract,
  findDuplicates: issueFindDuplicatesContract,
  get: issueGetContract,
  graph: issueGraphContract,
  integrate: issueIntegrateContract,
  linearSearch: issueLinearSearchContract,
  lint: issueLintContract,
  list: issueListContract,
  mailClaim: issueMailClaimContract,
  mailInbox: issueMailInboxContract,
  mailPending: issueMailPendingContract,
  mailSend: issueMailSendContract,
  markRead: issueMarkReadContract,
  markUnread: issueMarkUnreadContract,
  orphans: issueOrphansContract,
  panelApply: issuePanelApplyContract,
  preflight: issuePreflightContract,
  prime: issuePrimeContract,
  promote: issuePromoteContract,
  ready: issueReadyContract,
  refreshAssistant: issueRefreshAssistantContract,
  reparent: issueReparentContract,
  restore: issueRestoreContract,
  search: issueSearchContract,
  setCoordinator: issueSetCoordinatorContract,
  setLabels: issueSetLabelsContract,
  setNeedsHuman: issueSetNeedsHumanContract,
  setState: issueSetStateContract,
  setTucked: issueSetTuckedContract,
  stale: issueStaleContract,
  start: issueStartContract,
  stats: issueStatsContract,
  stop: issueStopContract,
  subscriptionAdd: issueSubscriptionAddContract,
  subscriptionList: issueSubscriptionListContract,
  subscriptionRemove: issueSubscriptionRemoveContract,
  subscriptionSetEnabled: issueSubscriptionSetEnabledContract,
  supersede: issueSupersedeContract,
  tree: issueTreeContract,
  undefer: issueUndeferContract,
  update: issueUpdateContract,
} as const

/** One issue-command def key. Derived from the table rather than restated — the
 *  protocol's hand-maintained `ISSUE_COMMAND_NAMES` list was the restatement, and
 *  POD-311 folds it in here (see `index.ts`). */
export type IssueContractName = keyof typeof ISSUE_CONTRACTS

/**
 * THE canonical issue-command name list, now DERIVED from the contract table.
 *
 * It was a hand-maintained `as const` array in `@podium/protocol` — a second place to
 * remember to edit, and the exact shape of restatement this issue exists to end. Both
 * sides of the wire still compile against one source; that source is now the table
 * that also carries the policy, so a name cannot exist without a contract.
 *
 * Sorted, because the protocol list was sorted and something downstream may reasonably
 * have depended on the order being stable.
 */
export const ISSUE_COMMAND_NAMES = Object.keys(ISSUE_CONTRACTS).sort() as readonly IssueContractName[]

/** Every issue contract as a flat list — what the classification lint and the audit
 *  iterate. */
export const ISSUE_CONTRACT_LIST = Object.values(ISSUE_CONTRACTS)
