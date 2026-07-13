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
  accountId: z.string(),
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
  assignedSessionId: z.string().nullable(),
  attempt: z.number().int().positive(),
  summary: z.string(),
  evidence: WorkflowStepEvidence,
  observation: WorkflowGitObservation.nullable(),
  warnings: z.array(z.string()),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
})
export type WorkflowRunStepWire = z.infer<typeof WorkflowRunStepWire>

export const WorkflowRunWire = z.object({
  id: z.string(),
  subjectKind: z.enum(['issue', 'session']),
  subjectId: z.string(),
  coordinatorSessionId: z.string(),
  revision: WorkflowRevisionWire,
  status: WorkflowRunStatus,
  supersedesRunId: z.string().nullable(),
  steps: z.array(WorkflowRunStepWire),
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
