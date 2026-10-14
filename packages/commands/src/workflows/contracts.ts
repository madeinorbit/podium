/**
 * The TEN workflow command contracts (ADR 3 D1, POD-311's L1/L3 split).
 *
 * `create · revise · fork · publish · assign ·
 *  checkpoint · assignStep · skip · retry · adopt`
 *
 * L1 DATA ONLY. Every handler lives with the workflow feature in `apps/server`
 * and is joined to its contract at `modules/workflows/registry.ts`. The three
 * QUERIES this surface also serves — `bindings`, `runs` — stay
 * hand-written in the service for now (POD-732 owns the cutover), but their
 * authorization no longer differs from a mutation's: all of it routes through
 * `workflowDecision`, which is why POD-730 pinned them.
 *
 * ---------------------------------------------------------------------------
 * TWO CLASSES, DECIDED PER CONTRACT AND RECORDED EITHER WAY
 * ---------------------------------------------------------------------------
 *
 * LIBRARY CRUD is entity-shaped: a definition, a revision, a binding. It edits
 * durable content whose conflict rule is `exp-rev` on ADR 1's matrix, which is
 * the rule an offline queue needs, so it is `offline-eligible`.
 *
 * ADVANCES are agent-driven and unattended: a checkpoint reports what a running
 * agent just did, against a run whose state has moved since. Replaying one from
 * a queue applies yesterday's observation to today's step. They are
 * `online-only` — and the reasoning is in `outboxReconciliation` on each, not
 * derived from a rule elsewhere, because a class derived silently is a class
 * nobody audits.
 *
 * The eleventh, `profileSave`, went with the execution profiles it saved
 * (POD-6114): a step now names an AGENT profile, which people edit through the
 * `agentProfiles` family, and which names no credential.
 *
 * ---------------------------------------------------------------------------
 * EXPOSURE IS DEFAULT-CLOSED AND MATCHES WHAT SHIPS
 * ---------------------------------------------------------------------------
 *
 * Every contract names `trpc` and `relay` — the two arms `router.ts` and
 * `relay.ts` actually serve today — and NOTHING names `outbox`, including the
 * offline-eligible ones. That is not an oversight: no client outbox path exists
 * for workflows, and ADR 3 D3's default-closed rule means a transport is served
 * because a contract names it, never because a class would have permitted it.
 * The offline CLASS is a statement about the command's shape; the EXPOSURE is a
 * statement about what is wired. Conflating them is how a surface opens itself.
 */

import { SessionIdField } from '@podium/model'
import {
  WorkflowBindingTarget,
  WorkflowGitObservation,
  WorkflowScope,
  WorkflowStep,
  WorkflowStepEvidence,
} from '@podium/protocol'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'
import type { AdvanceTarget, WorkflowAdvanceIdempotency } from './idempotency'

// ---------------------------------------------------------------------------
// A workflow contract is a command contract plus, for the five advances, the
// run-scoped idempotency declaration.
// ---------------------------------------------------------------------------

/**
 * `advance` is present iff the command mutates a RUN. Its absence on library
 * CRUD is meaningful and is checked (`contracts.test.ts` asserts the partition
 * against the eleven names), so "I forgot the declaration" and "this is not an
 * advance" do not look alike — the same reason `SERVED_NOWHERE` exists.
 */
export interface WorkflowCommandContract<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown>
  extends CommandContract<In, Out> {
  readonly advance?: WorkflowAdvanceIdempotency
}

// ---------------------------------------------------------------------------
// Shared input pieces — the SAME schemas the shipped surface validates with, so
// the cutover is a move and not a re-specification (POD-730 pins that duplicate
// step ids are rejected by the SCHEMA, not the service; that stays true here).
// ---------------------------------------------------------------------------

const workflowSteps = WorkflowStep.array().superRefine((steps, context) => {
  const seen = new Set<string>()
  steps.forEach((step, index) => {
    if (seen.has(step.id)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate workflow step id: ${step.id}`,
        path: [index, 'id'],
      })
    }
    seen.add(step.id)
  })
})

const scopeInput = z.object({
  scope: WorkflowScope,
  scopeRef: z.string().min(1).nullable().optional(),
})

/**
 * The delivery identity every advance carries (see `idempotency.ts`).
 *
 * OPTIONAL on the wire and REQUIRED in combination: a frame carrying neither
 * this nor a `stepId` is refused by the framework. Optionality here is a
 * compatibility fact — no shipped client mints one — not a licence.
 */
const mutationIdInput = z.string().min(1).optional()

// ---------------------------------------------------------------------------
// Shared policy cells, so a repeated rule cannot drift between contracts.
// ---------------------------------------------------------------------------

/** Both shipped arms. See the header: this is what is WIRED, not what a class
 *  would permit. */
const SERVED_ON: readonly TransportTag[] = ['trpc', 'relay']

/**
 * ADR 3 D8 / Amendment 1 D16, and ADR 9 D5 A1 — the same sentence on every
 * contract because it is the same rule, and a rule restated eleven times in
 * eleven wordings is a rule that will be eleven rules by the next issue.
 *
 * The half that is easy to leave out is what the SENDER is told: a revoked
 * delegation must fail the way an unknown id fails, or the refusal itself
 * reports that the run exists.
 */
const REAUTHORIZATION =
  'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1): the agent’s own ' +
  'scope intersected with its human’s CURRENT rights, never a capability frozen at spawn. A ' +
  'delegation that no longer resolves denies the apply, and the denial is byte-identical to an ' +
  'unknown id (Amendment 1 D20.2) so the refusal is not itself an existence oracle.'

const LIBRARY_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'Entity-shaped and `exp-rev` on ADR 1’s matrix, which is the conflict rule an outbox replay ' +
    'needs: a queued revise appends a version rather than overwriting one, so a replay after the ' +
    'library moved is a new revision and not a lost edit. NOT exposed on `outbox` today — no client ' +
    'outbox path exists for workflows, and ADR 3 D3 serves a transport because a contract names it.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * The advance class, with the reasoning the brief asked to be recorded EITHER
 * WAY. It is presumptively online-only because advances are agent-driven; the
 * presumption is confirmed here rather than inherited, because the concrete
 * reason is stronger than the presumption.
 */
const ADVANCE_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. An advance reports what a running agent just observed about a run whose state has ' +
    'since moved; replaying it from a queue applies yesterday’s summary, evidence and git observation ' +
    'to whatever step is current now — which is the same failure mode as POD-730 §6’s double-advance, ' +
    'arriving by a different road. ADR 3 D4 rule 4’s distinction applies: the relay’s durable agent ' +
    'queue is a delivery mechanism for an already-authorized ONLINE command, not a client Outbox class.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/** No sensitive path, reviewed. Library content is instructions and step text
 *  the author wrote; it carries no credential and no machine identity. */
const LIBRARY_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note: 'Workflow instructions and step text are author-written prose. Nothing here is a credential, a token or a path into someone’s machine.',
}

/**
 * ADR 9 D5 A3, on every contract: attribution is a PAIR and both halves are
 * stamped from the transport principal.
 *
 * `wirePlacement: 'separate-field'` is the decision this issue was asked to
 * make explicitly. The alternative — folding the human into the existing
 * `created_by_id` / `updated_by_id` column — is exactly the substitution A3
 * forbids: it would answer "who did this" with one id and make "did a person or
 * an agent skip this step?" unanswerable, which is the question run history
 * exists to answer.
 */
const ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'ADR 9 D5 A3: run history and every library write record WHICH agent or session acted and WHICH ' +
    'human it acted for, both from the transport principal and never from payload. Folding the human ' +
    'into the shipped `created_by_id` column would substitute one identity for the pair and lose the ' +
    'person/agent distinction the history exists to preserve.',
}

/**
 * Amendment 1 D20.3 / readiness §3.1.5, on every contract that takes a
 * caller-supplied id: invisible must fail as nonexistent.
 *
 * POD-730 §10 pins today's divergence in five directions — `unknown workflow:
 * <id>` against `workflow is outside this session`, and a revision id that
 * CONFIRMS existence before refusing. Converging them is a deliberate change,
 * expressed here as metadata so the handlers do not each carry a string.
 */
const CONSISTENT_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'An id the principal may not see fails identically to an id that does not exist — same message, ' +
    'no code on either. POD-730 §10 pinned five divergent shapes; this converges them. Machine ' +
    'placement is the ONE carve-out and it is not on this path (readiness §3.1.4 M5 pulls the other ' +
    'way): see the assign-time placement check.',
}

/** Ownership on create — ADR 9 D5 A4 and readiness §3.1.2's inheritance rule,
 *  declared per contract rather than left to handler code. */
const OWNED_BY_HUMAN = (creates: readonly string[], note: string) =>
  ({
    creates,
    owner: 'on-behalf-of-human',
    visibility: 'personal',
    inheritanceOnCreate: 'on-behalf-of-human',
    note,
  }) as const

/**
 * THE VISIBILITY CLASS OF WHAT EVERY WORKFLOW COMMAND WRITES (POD-382's field,
 * ADR 9 D3/D4, readiness §3.1.1).
 *
 * ONE CONSTANT FOR ALL TEN, and the sameness is a finding rather than a
 * rubber stamp: POD-731 declared the workflow classes — definitions,
 * revisions, bindings and runs — on ADR 1's ownership
 * matrix, and every one of them resolved `personal`. A command writes state in
 * one of those classes and nothing else, so there is no ten-way
 * judgement to make here and pretending otherwise by writing the literal out
 * ten times would invite someone to change one of them in isolation.
 *
 * IT IS NOT A GUESS AND IT IS NOT INDEPENDENT OF THE MATRIX: `contracts.test.ts`
 * asserts this value against `visibilityClassOf()` for each matrix row a command
 * writes, so if POD-1071 ever reclassifies one of them, the contracts go RED
 * rather than quietly disagreeing with the row they are supposed to mirror. That
 * check is the reason this is a constant and not a comment.
 *
 * IT IS A CLASSIFICATION, NOT A TEMPLATE. `personal` here says the state these
 * ten write is one shared fact owned by one person — it is not a default to
 * copy onto the next workflow-adjacent command. A facet whose value DIFFERS PER
 * READER is `per-user-state` and a different row family entirely; see the
 * warning on `workflowAssignContract`, which is the one of the ten a future
 * per-user preference would most plausibly be copied from.
 */
const WORKFLOW_VISIBILITY = 'personal' as const

// ---------------------------------------------------------------------------
// LIBRARY CRUD
// ---------------------------------------------------------------------------

export const workflowCreateInput = scopeInput.extend({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(''),
  instructions: z.string().default(''),
  steps: workflowSteps.default([]),
})

export const workflowCreateContract = {
  name: 'workflows.create',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowCreateInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'issue',
    confirmation: 'confirm',
    rationale:
      'Creating a task- or repository-scoped workflow writes personal content owned by the acting ' +
      'agent’s human (ADR 9 D5 A4), so a member may do it. The GLOBAL arm is not a member’s to take: ' +
      'a global library entry is substrate-shaped (readiness §3.1.1), so `scope: "global"` is decided ' +
      'as `workflow-library-entry` and its WRITE needs the admin grade — which is why the role floor ' +
      'here is a floor on ATTEMPTING and not the whole decision. The shipped code returned EARLY for ' +
      '`scope === "global"`, letting any caller create instance-wide content; that ambient arm is gone. ' +
      'Its READ is NOT widened to tenant-visible: that is ADR 1 Amendment 1 D9.3’s one-way ratchet and ' +
      'POD-1071’s to turn, and ADR 9 D2’s explicit grant edge reaches the same reach revocably.',
  },
  exposure: SERVED_ON,
  delivery: LIBRARY_DELIVERY,
  redaction: LIBRARY_REDACTION,
  ownership: OWNED_BY_HUMAN(
    ['workflow-definition', 'workflow-revision'],
    'The definition and its v1 revision are owned by the creating principal’s human; the revision ' +
      'inherits the definition. A GLOBAL definition is owned by the ADMIN who created it and is shared ' +
      'by an explicit read grant, not by an ambient arm — so the library stays exactly as readable as ' +
      'it is today, through an edge a reader can be shown and an owner can revoke.',
  ),
  attribution: ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note: 'Create takes a scope and a scopeRef, not a target workflow id. The scopeRef IS caller-supplied, but it names an issue/session/repo the caller must already be in, and the scope guard’s refusal predates this issue and names nothing the caller could not see.',
  },
  cli: { summary: 'Create a workflow and its first revision' },
  conflict: 'append',
} as const satisfies WorkflowCommandContract

export const workflowReviseInput = z.object({
  workflowId: z.string().min(1),
  instructions: z.string().default(''),
  steps: workflowSteps.default([]),
})

export const workflowReviseContract = {
  name: 'workflows.revise',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowReviseInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'issue',
    confirmation: 'confirm',
    rationale:
      'Revision immutability makes this an APPEND: a prior revision is never edited in place, so the ' +
      'write authority needed is over the definition, not over any published revision. Owner-or-admin ' +
      'against the definition’s owner; the shipped `assertWorkflowWrite` returned early for the ' +
      'operator AND for any global workflow, and both arms are replaced.',
  },
  exposure: SERVED_ON,
  delivery: LIBRARY_DELIVERY,
  redaction: LIBRARY_REDACTION,
  ownership: OWNED_BY_HUMAN(
    ['workflow-revision'],
    'A revision inherits its DEFINITION’s owner and grants, not the reviser’s — readiness §3.1.2’s ' +
      'parent rule. Otherwise a shared workflow would fragment into per-reviser ownership one edit at ' +
      'a time, and the person who shared it would lose the ability to read what it became.',
  ),
  attribution: ATTRIBUTION,
  errorConsistency: CONSISTENT_ERRORS,
  cli: { positional: ['workflowId'], summary: 'Append a revision' },
  conflict: 'append',
} as const satisfies WorkflowCommandContract

export const workflowForkInput = scopeInput.extend({
  revisionId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(''),
})

export const workflowForkContract = {
  name: 'workflows.fork',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowForkInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'issue',
    confirmation: 'confirm',
    rationale:
      'Fork READS a source revision and CREATES a new definition, so it is two decisions and both are ' +
      'taken: read on the source (which is how a revision id stops being an existence oracle) and ' +
      'create on the destination scope. The destination decides the owner — a fork of someone else’s ' +
      'shared workflow belongs to the forker’s human, which is what makes forking a safe way to adapt ' +
      'shared content rather than a way to acquire it.',
  },
  exposure: SERVED_ON,
  delivery: LIBRARY_DELIVERY,
  redaction: LIBRARY_REDACTION,
  ownership: OWNED_BY_HUMAN(
    ['workflow-definition', 'workflow-revision'],
    'The FORK is owned by the forking principal’s human, never by the source’s owner. Lineage is a ' +
      'separate fact from ownership; POD-730 §2 records that no lineage is stored at all today.',
  ),
  attribution: ATTRIBUTION,
  errorConsistency: CONSISTENT_ERRORS,
  cli: { positional: ['revisionId'], summary: 'Copy a revision into a new workflow' },
  conflict: 'append',
} as const satisfies WorkflowCommandContract

export const workflowPublishInput = z.object({ revisionId: z.string().min(1) })

export const workflowPublishContract = {
  name: 'workflows.publish',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowPublishInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'issue',
    confirmation: 'confirm',
    rationale:
      'Publishing marks a revision as fit for others to run. On a personal workflow that is the ' +
      'owner’s call; on a GLOBAL one it is instance-wide substrate and admin-grade. This is the ONE ' +
      'brake that already existed ("approval required to publish a global workflow revision"), and it ' +
      'is the precedent the closed global-create/revise path builds on rather than a second, parallel ' +
      'approval notion — readiness §3.1.1, and the brief’s instruction not to invent one.',
  },
  exposure: SERVED_ON,
  delivery: LIBRARY_DELIVERY,
  redaction: LIBRARY_REDACTION,
  ownership: { creates: [], note: 'Publish stamps `publishedAt` on an existing revision.' },
  attribution: ATTRIBUTION,
  errorConsistency: CONSISTENT_ERRORS,
  cli: { positional: ['revisionId'], summary: 'Publish a revision' },
  conflict: 'cmd',
  conflictRule:
    'Flips a definition between personal and global; owner-or-admin only, idempotent, and a concurrent publish and unpublish resolve to the later Authority commit',
} as const satisfies WorkflowCommandContract

export const workflowAssignInput = z.object({
  targetKind: WorkflowBindingTarget,
  targetId: z.string(),
  revisionId: z.string().min(1),
})

export const workflowAssignContract = {
  name: 'workflows.assign',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowAssignInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'issue',
    confirmation: 'confirm',
    rationale:
      'A binding attaches a revision to a target, and the authority it needs is authority over the ' +
      'TARGET: an issue binding needs the issue, a session binding needs that session, and the ' +
      'global/repository arms are substrate and stay admin-grade — the shipped `protectedWrite` check, ' +
      'kept, plus the published-revision precondition it is checked BEFORE (POD-730 pins that order).',
  },
  /**
   * DO NOT COPY THIS CONTRACT FOR A PER-USER PREFERENCE (POD-311, POD-1076).
   *
   * This is the one of the ten with POD-351's rename-contract trap, and it is
   * flagged here because the trap is invisible from the classification: a
   * binding is `(target_kind, target_id) → revision`, which is structurally a
   * PIN, and `pins` / `snoozes` / `tab_order` are exactly the family POD-380 had
   * to re-key `(userId, entity)` after they shipped instance-wide.
   *
   * A binding is `personal` because it is ONE SHARED FACT about a target —
   * "this issue runs that workflow" is true for everyone who can see the issue,
   * which is why it inherits the target's owner and grants rather than the
   * binder's. A future "my default workflow for this repo" is a DIFFERENT fact:
   * it differs per reader, so it is `per-user-state`, keyed `(userId, target)`,
   * writable by the owning user ONLY — not admins, not `system`, not agents
   * acting on behalf — and it must not ride the binding's wire projection,
   * because a value that differs per reader cannot be a field of a shape
   * broadcast to many readers.
   *
   * Copying this contract for that feature would key a personal preference as a
   * shared instance-wide row: visible to everyone who can see the target, and
   * silently overwritable by any of them.
   *
   * ADJUDICATED BY POD-1076, and the classification STANDS: a binding is not a
   * family member. What POD-1076 changes is that the warning above now has a
   * concrete destination instead of a description — `@podium/model`'s
   * `user-state/` family is built, keyed over the one `perUserKey` fragment, so
   * "my default workflow for this repo" composes that rather than being invented
   * beside it. The copy trap is unchanged; the correct alternative is no longer
   * hypothetical.
   */
  exposure: SERVED_ON,
  delivery: LIBRARY_DELIVERY,
  redaction: LIBRARY_REDACTION,
  ownership: OWNED_BY_HUMAN(
    ['workflow-binding'],
    'A binding inherits the TARGET it binds — the issue’s or the session’s owner and grants, not the ' +
      'binder’s. Sharing an issue must share what runs on it; a binding owned by whoever last changed ' +
      'it would make the issue’s owner unable to see why their own issue starts the workflow it does.',
  ),
  attribution: ATTRIBUTION,
  errorConsistency: CONSISTENT_ERRORS,
  cli: { summary: 'Bind a revision to a target' },
  conflict: 'cmd',
  conflictRule:
    'One binding per (target, workflow); assigning replaces the target existing binding in a single Authority commit rather than accumulating two',
} as const satisfies WorkflowCommandContract

// ---------------------------------------------------------------------------
// RUN ADVANCES — the five that carry the run-id resource scope
// ---------------------------------------------------------------------------

const advanceIdempotency = (
  targetNamedBy: AdvanceTarget,
  rationale: string,
): WorkflowAdvanceIdempotency => ({
  resourceScope: 'run',
  targetNamedBy,
  rationale,
})

/**
 * The advance policy cell. `resource: 'session'` because a run's resource
 * IDENTITY is the run and ADR 3 D2's closed vocabulary has no `run` member —
 * a run is reached through the session that coordinates it, which is exactly
 * how `runFor` resolves one. The run-id scope itself is carried by
 * {@link WorkflowAdvanceIdempotency.resourceScope}, so it is written down
 * rather than approximated by the nearest D2 member.
 */
const advancePolicy = (rationale: string) =>
  ({
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale,
  }) as const

const ADVANCE_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note: 'A checkpoint summary, its evidence and its git observation are agent-authored prose plus branch/worktree paths. Paths are already visible to anyone who may see the run, and the run itself is owner-gated, so there is nothing here to redact that visibility does not already decide.',
}

const RUN_ADVANCE_OWNERSHIP = {
  creates: [],
  note:
    'An advance creates no entity: it moves an existing run. The RUN’s own ownership is declared on ' +
    'ADR 1’s matrix and inherits the ISSUE or SESSION it advances (readiness §3.1.2), NOT the actor — ' +
    'a colleague’s agent checkpointing your issue must not acquire your run.',
} as const

export const workflowCheckpointInput = z.object({
  runId: z.string().optional(),
  stepId: z.string().optional(),
  mutationId: mutationIdInput,
  status: z.enum(['active', 'blocked', 'complete']),
  summary: z.string().max(16_000).default(''),
  evidence: WorkflowStepEvidence.default({}),
  observation: WorkflowGitObservation.nullable().optional(),
})

export const workflowCheckpointContract = {
  name: 'workflows.checkpoint',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowCheckpointInput,
  policy: advancePolicy(
    'The coordinator or the step’s ASSIGNEE may checkpoint — the shipped rule, minus its operator ' +
      'arm, which accepted any operator for any step whether assigned or not. Assignment is the ' +
      'authorization here, so it is checked against the run’s own step records rather than against a ' +
      'role class.',
  ),
  exposure: SERVED_ON,
  delivery: ADVANCE_DELIVERY,
  redaction: ADVANCE_REDACTION,
  ownership: RUN_ADVANCE_OWNERSHIP,
  attribution: ATTRIBUTION,
  errorConsistency: CONSISTENT_ERRORS,
  advance: advanceIdempotency(
    'step',
    'THE case the framework exists for. POD-730 §6: a checkpoint with no `stepId` re-resolves the ' +
      'current step, so a duplicate delivery completes the NEXT step with the FIRST delivery’s summary ' +
      'and evidence, and a third finishes the run. A frame that names neither a step nor a mutation id ' +
      'is refused; either one closes it.',
  ),
  cli: { summary: 'Report step progress' },
  conflict: 'cmd',
  conflictRule:
    'Advances ROW.workflowRuns, whose declared rule is cmd; a checkpoint against a step that is no longer current is refused rather than applied out of order',
} as const satisfies WorkflowCommandContract

export const workflowAssignStepInput = z.object({
  runId: z.string().optional(),
  stepId: z.string().min(1),
  mutationId: mutationIdInput,
  sessionId: SessionIdField.nullable(),
})

export const workflowAssignStepContract = {
  name: 'workflows.assignStep',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowAssignStepInput,
  policy: advancePolicy(
    'Coordinator-only. Assigning a step places work on a session, and under readiness §3.1.4 M5 that ' +
      'placement FAILS CLOSED against a machine the effective principal lacks `use` on — checked here ' +
      'at assign time and again at apply, with unauthorized distinguishable from unreachable and ' +
      'never silently retargeted.',
  ),
  exposure: SERVED_ON,
  delivery: ADVANCE_DELIVERY,
  redaction: ADVANCE_REDACTION,
  ownership: RUN_ADVANCE_OWNERSHIP,
  attribution: ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: true,
    note: 'Run and step ids follow D20.2. The MACHINE the assignee sits on follows M5 instead: denied and unreachable stay distinguishable, because placing code on someone’s hardware is a code-execution boundary and an operator must be able to tell a permissions problem from a dead machine.',
  },
  advance: advanceIdempotency(
    'step',
    'Idempotent in effect today (POD-730 §6), which is a property of assignment being a SET rather ' +
      'than a guarantee of the delivery path. Declared so the framework rule holds if the handler ' +
      'ever stops being a pure set.',
  ),
  cli: { positional: ['stepId', 'sessionId'], summary: 'Assign the current step' },
  conflict: 'cmd',
  conflictRule:
    'Advances ROW.workflowRuns; assignment of a step already claimed by another principal is refused, so two claimants do not both proceed',
} as const satisfies WorkflowCommandContract

export const workflowSkipInput = z.object({
  runId: z.string().optional(),
  stepId: z.string().min(1),
  mutationId: mutationIdInput,
  reason: z.string().default(''),
})

export const workflowSkipContract = {
  name: 'workflows.skip',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowSkipInput,
  policy: advancePolicy(
    'Coordinator-only, and only the CURRENT step may be skipped — the state-machine invariant, which ' +
      'survives the move to a handler unchanged.',
  ),
  exposure: SERVED_ON,
  delivery: ADVANCE_DELIVERY,
  redaction: ADVANCE_REDACTION,
  ownership: RUN_ADVANCE_OWNERSHIP,
  attribution: ATTRIBUTION,
  errorConsistency: CONSISTENT_ERRORS,
  advance: advanceIdempotency(
    'step',
    'A duplicate is already refused by the only-current-step guard, since the first skip moved the ' +
      'step out of current. `stepId` is REQUIRED on this input, so the ambiguous frame is unreachable ' +
      'by construction — the declaration records that it was decided, not that it was needed.',
  ),
  cli: { positional: ['stepId'], summary: 'Skip the current step' },
  conflict: 'cmd',
  conflictRule:
    'Advances ROW.workflowRuns; skipping a step that is not current is refused, and a second skip of the same step is a no-op',
} as const satisfies WorkflowCommandContract

export const workflowRetryInput = z.object({
  runId: z.string().optional(),
  stepId: z.string().min(1),
  mutationId: mutationIdInput,
})

export const workflowRetryContract = {
  name: 'workflows.retry',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowRetryInput,
  policy: advancePolicy(
    'Coordinator-only. The invariant is that no step may be retried once a LATER step has left ' +
      'pending — merely active is enough, and a later skipped step also locks it.',
  ),
  exposure: SERVED_ON,
  delivery: ADVANCE_DELIVERY,
  redaction: ADVANCE_REDACTION,
  ownership: RUN_ADVANCE_OWNERSHIP,
  attribution: ATTRIBUTION,
  errorConsistency: CONSISTENT_ERRORS,
  advance: advanceIdempotency(
    'step',
    'The one advance whose duplicate is NOT refused today: each delivery bumps `attempt` (POD-730 §6). ' +
      '`stepId` is required so the ambiguous frame cannot occur, and a mutation id makes the replay ' +
      'return the first result instead of a second attempt.',
  ),
  cli: { positional: ['stepId'], summary: 'Reset a step for another attempt' },
  conflict: 'cmd',
  conflictRule:
    'Advances ROW.workflowRuns; retry applies only to a step in a failed state, so a retry racing a late success is refused',
} as const satisfies WorkflowCommandContract

export const workflowAdoptInput = z.object({
  revisionId: z.string().min(1),
  runId: z.string().optional(),
  mutationId: mutationIdInput,
  startStepId: z.string().optional(),
})

export const workflowAdoptContract = {
  name: 'workflows.adopt',
  version: 1,
  visibility: WORKFLOW_VISIBILITY,
  input: workflowAdoptInput,
  policy: advancePolicy(
    'Coordinator-only, and only on an ACTIVE or BLOCKED run. Adopt reads a revision as well as ' +
      'advancing a run, so the revision’s read decision is taken too — and it is taken BEFORE the live ' +
      'run is superseded, which is what keeps a failed adopt from leaving the run half-replaced.',
  ),
  exposure: SERVED_ON,
  delivery: ADVANCE_DELIVERY,
  redaction: ADVANCE_REDACTION,
  ownership: {
    creates: ['workflow-run'],
    owner: 'on-behalf-of-human',
    visibility: 'personal',
    inheritanceOnCreate: 'parent',
    note: 'Adopt supersedes one run and starts another. The NEW run inherits the ISSUE or SESSION it advances — readiness §3.1.2’s parent rule — not the adopting agent’s human: a coordinator adopting a revision on your issue must not take ownership of your issue’s run.',
  },
  attribution: ATTRIBUTION,
  errorConsistency: CONSISTENT_ERRORS,
  advance: advanceIdempotency(
    'run',
    'THE TARGET IS THE RUN, so there is no step to name and the unnamed-frame refusal does not apply. ' +
      'Its duplicate is a real hazard all the same — a second adopt supersedes the run the FIRST one ' +
      'created and starts a third — and the close for it is the mutation-id ledger alone. POD-731 ' +
      'RECORDED it rather than fixing it, because refusing every adopt that carries no mutation id ' +
      'would break six behaviours POD-730 pinned for a hazard nobody has hit. ' +
      'POD-732 CLOSED IT FOR AN IDENTIFIED DELIVERY and still refuses nothing: the cutover made ' +
      'adopt’s callers enumerable, so the CLI now mints one mutation id per invocation and a repeated ' +
      'DELIVERY of that invocation is a ledger replay — the handler is not invoked and the first ' +
      'result comes back verbatim. Two separate invocations remain two intents and still supersede; ' +
      'deduping those would answer a question the operator did not ask. What is still open is an ' +
      'unidentified adopt, which is a REFUSAL question and stays POD-731’s six-pin problem.',
  ),
  cli: { positional: ['revisionId'], summary: 'Adopt a revision mid-run' },
  conflict: 'cmd',
  conflictRule:
    'Supersedes one run and starts another in a single Authority commit; a run already superseded cannot be adopted twice',
} as const satisfies WorkflowCommandContract

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * The ten, keyed by the BARE proc name every transport already dispatches on
 * — `create`, `checkpoint`, … The wire names are kept: renaming them is a
 * client-compatibility change and this issue is a migration, not a rename. The
 * contract's own dotted name (`workflows.checkpoint`) is the identity the
 * classification lint and the audit read.
 */
export const WORKFLOW_CONTRACTS = {
  create: workflowCreateContract,
  revise: workflowReviseContract,
  fork: workflowForkContract,
  publish: workflowPublishContract,
  assign: workflowAssignContract,
  checkpoint: workflowCheckpointContract,
  assignStep: workflowAssignStepContract,
  skip: workflowSkipContract,
  retry: workflowRetryContract,
  adopt: workflowAdoptContract,
} as const

export type WorkflowContractName = keyof typeof WORKFLOW_CONTRACTS

/**
 * The five advances, derived from the `advance` declaration rather than
 * restated — a second list is a second thing to forget to update.
 *
 * THE TWO WIDENING CASTS BELOW ARE ORDINARY, AND THE NOTE IS HERE BECAUSE THEY
 * ONCE LOOKED LIKE SOMETHING ELSE. `Object.entries` widens a literal key type
 * to `string`, and `advance` is absent from the six library contracts' concrete
 * types, so a heterogeneous read of the table needs both. They are NOT variance
 * workarounds.
 *
 * When POD-382 added the required `visibility` field to `CommandContractBase`,
 * these two lines were the errors that surfaced (TS2352, "neither type
 * sufficiently overlaps"), and TypeScript's suggested remedy — cast through
 * `unknown` — would have compiled. It would also have left all the contracts
 * with NO visibility class, silently defeating the compile-time half of the
 * default-closed rule that both POD-382 and this issue exist to enforce. The
 * cast was reporting a missing required PROPERTY, not a variance problem. If
 * these ever go red again, look for the field before reaching for `unknown`.
 */
export const WORKFLOW_ADVANCE_NAMES: readonly WorkflowContractName[] = (
  Object.entries(WORKFLOW_CONTRACTS) as [WorkflowContractName, WorkflowCommandContract][]
)
  .filter(([, contract]) => contract.advance !== undefined)
  .map(([name]) => name)

/** The advance declaration for a command, or `undefined` when it is library
 *  CRUD. The one reader of the heterogeneous table's `advance` field, so the
 *  widening cast lives here instead of at every call site. */
export const workflowAdvanceOf = (
  name: WorkflowContractName,
): WorkflowAdvanceIdempotency | undefined =>
  (WORKFLOW_CONTRACTS[name] as WorkflowCommandContract).advance
