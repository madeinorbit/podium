import { AccountIdField, SessionIdField } from '@podium/model'
import { z } from 'zod'

/** Instruction-first workflows. Markdown remains the primary contract; the
 * optional ordered steps exist only to make progress + handoff explicit. */
export const WorkflowScope = z.enum(['global', 'repository', 'task'])
export type WorkflowScope = z.infer<typeof WorkflowScope>

export const WorkflowStep = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().default(''),
  completionGuidance: z.string().default(''),
  executionProfileId: z.string().optional(),
})
export type WorkflowStep = z.infer<typeof WorkflowStep>

export const WorkflowWire = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  scope: WorkflowScope,
  scopeRef: z.string().nullable(),
  latestRevisionId: z.string().nullable(),
  latestVersion: z.number().int().nonnegative(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WorkflowWire = z.infer<typeof WorkflowWire>

export const WorkflowRevisionWire = z.object({
  id: z.string(),
  workflowId: z.string(),
  version: z.number().int().positive(),
  instructions: z.string(),
  steps: z.array(WorkflowStep),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
})
export type WorkflowRevisionWire = z.infer<typeof WorkflowRevisionWire>

export const WorkflowDetailWire = z.object({
  workflow: WorkflowWire,
  revisions: z.array(WorkflowRevisionWire),
})
export type WorkflowDetailWire = z.infer<typeof WorkflowDetailWire>

export const WorkflowBindingTarget = z.enum(['global', 'repository', 'issue', 'session'])
export type WorkflowBindingTarget = z.infer<typeof WorkflowBindingTarget>

export const WorkflowBindingWire = z.object({
  targetKind: WorkflowBindingTarget,
  targetId: z.string(),
  revisionId: z.string(),
  updatedAt: z.string(),
})
export type WorkflowBindingWire = z.infer<typeof WorkflowBindingWire>

/** A named, non-secret launch preset. accountId points at Podium's account
 * inventory; credentials never enter workflow data. */
export const ExecutionProfileWire = z.object({
  id: z.string(),
  name: z.string(),
  accountId: AccountIdField,
  machineId: z.string().nullable(),
  harness: z.string(),
  model: z.string(),
  effort: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ExecutionProfileWire = z.infer<typeof ExecutionProfileWire>

export const WorkflowRunStatus = z.enum(['active', 'blocked', 'complete', 'superseded'])
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>
export const WorkflowRunStepStatus = z.enum(['pending', 'active', 'blocked', 'complete', 'skipped'])
export type WorkflowRunStepStatus = z.infer<typeof WorkflowRunStepStatus>

export const WorkflowGitObservation = z.object({
  cwd: z.string(),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  dirty: z.boolean().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  observedAt: z.string(),
})
export type WorkflowGitObservation = z.infer<typeof WorkflowGitObservation>

export const WorkflowStepEvidence = z.object({
  summary: z.string().default(''),
  tests: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
})
export type WorkflowStepEvidence = z.infer<typeof WorkflowStepEvidence>

export const WorkflowRunStepWire = z.object({
  stepId: z.string(),
  position: z.number().int().nonnegative(),
  title: z.string(),
  instructions: z.string(),
  completionGuidance: z.string(),
  executionProfileId: z.string().nullable(),
  executionProfileSnapshot: ExecutionProfileWire.nullable(),
  status: WorkflowRunStepStatus,
  assignedSessionId: SessionIdField.nullable(),
  attempt: z.number().int().positive(),
  summary: z.string(),
  evidence: WorkflowStepEvidence,
  observation: WorkflowGitObservation.nullable(),
  warnings: z.array(z.string()),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
})
export type WorkflowRunStepWire = z.infer<typeof WorkflowRunStepWire>

/**
 * ONE RECORDED ACT ON A RUN, WITH ITS ATTRIBUTION PAIR (ADR 9 D5 A3, readiness
 * §3.1.3 A3).
 *
 * `actorKind`/`actorId` is WHICH agent, session or operator acted; `onBehalfOf`
 * is WHICH HUMAN it acted for. Two fields and not one, because "did a person or
 * an agent skip this step?" and "whose authority was it under?" are different
 * questions — and the UI has to be able to answer both without asserting
 * either.
 *
 * READ-ONLY, AND STAMPED SERVER-SIDE. Every field here is projected from
 * `workflow_events`, whose columns are written from the authenticated transport
 * principal (ADR 3 D7: payload identity is inert). No client input reaches any
 * of them, and no command payload on this surface carries an actor, an owner or
 * an origin. This wire exists so the UI can DISPLAY the pair, never so it can
 * supply it.
 *
 * `onBehalfOf` STAYS NULLABLE. A `system` principal has no human behind it by
 * construction (ADR 9 D8 S5) and must not be given one; collapsing that null to
 * an empty string would make "none by construction" and "we failed to record
 * one" compare equal. The client renders the null as "no delegating human"
 * rather than inventing the operator.
 */
export const WorkflowRunEventWire = z.object({
  /** The event kind as the engine recorded it — `run.started`, `step.skipped`, … */
  kind: z.string(),
  actorKind: z.string(),
  /** Null for rows whose actor predates the column. Never substituted. */
  actorId: z.string().nullable(),
  onBehalfOf: z.string().nullable(),
  createdAt: z.string(),
})
export type WorkflowRunEventWire = z.infer<typeof WorkflowRunEventWire>

export const WorkflowRunWire = z.object({
  id: z.string(),
  subjectKind: z.enum(['issue', 'session']),
  subjectId: z.string(),
  coordinatorSessionId: SessionIdField,
  revision: WorkflowRevisionWire,
  status: WorkflowRunStatus,
  supersedesRunId: z.string().nullable(),
  steps: z.array(WorkflowRunStepWire),
  /** The run's recorded acts, oldest first, each with its attribution PAIR.
   *  Defaulted to empty so a peer that predates the field parses unchanged. */
  history: z.array(WorkflowRunEventWire).default([]),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
})
export type WorkflowRunWire = z.infer<typeof WorkflowRunWire>

export const WorkflowNextActionWire = z.object({
  run: WorkflowRunWire,
  currentStep: WorkflowRunStepWire.nullable(),
  nextStep: WorkflowRunStepWire.nullable(),
  message: z.string(),
  warnings: z.array(z.string()),
})
export type WorkflowNextActionWire = z.infer<typeof WorkflowNextActionWire>
