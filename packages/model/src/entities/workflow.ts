/**
 * WORKFLOWS AS SYNCED RECORDS (POD-6676, ADR 12 D1; design POD-5620 §1.10).
 *
 * Relocated from `@podium/protocol`'s `messages/workflows.ts`, byte-identical
 * on the wire, the day the family joined `MetadataEntityKind`: the decision
 * recorded there (POD-1127) said a workflow kind on the feed makes these
 * entities, and entities live here. Protocol re-exports every name, so its
 * importers did not move.
 *
 * Four kinds ride the feed:
 *  - `workflow` ({@link WorkflowWire}): the definition. Its revision pointers
 *    (`latestRevisionId`, `latestVersion`) are the server's, set when a
 *    revision is written or published.
 *  - `workflowRevision` ({@link WorkflowRevisionWire}): immutable once
 *    published, small, so every revision is synced.
 *  - `workflowBinding` ({@link WorkflowBindingWire}): one per target, keyed
 *    {@link workflowBindingRowId}.
 *  - `workflowRun` ({@link WorkflowRunRecord}): status written by the server.
 *    It names its revision by id and carries no history: the history grows,
 *    so it stays a request answer (`workflows.status`).
 */

import { z } from 'zod'
import { SessionIdField } from '../ids'
import { AgentProfileWire } from './agent-profile'

/** Instruction-first workflows. Markdown remains the primary contract; the
 * optional ordered steps exist only to make progress + handoff explicit. */
export const WorkflowScope = z.enum(['global', 'repository', 'task'])
export type WorkflowScope = z.infer<typeof WorkflowScope>

export const WorkflowStep = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().default(''),
  completionGuidance: z.string().default(''),
  /** The agent profile (name or id) the step's work runs with. A run pins the
   *  profile as it is when the run starts. */
  agentProfile: z.string().min(1).max(256).optional(),
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

export const WorkflowBindingTarget = z.enum(['global', 'repository', 'issue', 'session'])
export type WorkflowBindingTarget = z.infer<typeof WorkflowBindingTarget>

export const WorkflowBindingWire = z.object({
  targetKind: WorkflowBindingTarget,
  targetId: z.string(),
  revisionId: z.string(),
  updatedAt: z.string(),
})
export type WorkflowBindingWire = z.infer<typeof WorkflowBindingWire>

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
  /** The step's agent profile: its id once resolved, else the ref the step
   *  named (the profile did not exist when the run started). */
  agentProfileId: z.string().nullable(),
  /** The profile as it was when the run started; editing the profile later
   *  never changes a run in flight. Null when the step names none, or it was
   *  missing. */
  agentProfileSnapshot: AgentProfileWire.nullable(),
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
 * ONE WORKFLOW RUN AS THE FEED CARRIES IT (design §1.10). The request answer's
 * run (`WorkflowRunWire` in `@podium/protocol`) embeds its revision and its
 * history; the record names the revision by id (it is its own synced record)
 * and leaves the history to the request, because it grows without bound.
 */
export const WorkflowRunRecord = z.object({
  id: z.string(),
  subjectKind: z.enum(['issue', 'session']),
  subjectId: z.string(),
  coordinatorSessionId: SessionIdField,
  revisionId: z.string(),
  /** The workflow the revision belongs to, so a run joins its definition
   *  without the revision row (a fact of the revision, which never changes). */
  workflowId: z.string(),
  status: WorkflowRunStatus,
  supersedesRunId: z.string().nullable(),
  steps: z.array(WorkflowRunStepWire),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
})
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecord>

/** A binding's feed id: its target, the key a binding is unique by. The kind
 *  is an enum without `:`, so the first `:` splits the pair; a global binding's
 *  target id is empty. The same string the ownership checks name it by. */
export function workflowBindingRowId(targetKind: WorkflowBindingTarget, targetId: string): string {
  return `${targetKind}:${targetId}`
}

/** Inverse of {@link workflowBindingRowId}; `undefined` for a malformed id. */
export function parseWorkflowBindingRowId(
  id: string,
): { targetKind: WorkflowBindingTarget; targetId: string } | undefined {
  const split = id.indexOf(':')
  if (split < 0) return undefined
  const kind = WorkflowBindingTarget.safeParse(id.slice(0, split))
  return kind.success ? { targetKind: kind.data, targetId: id.slice(split + 1) } : undefined
}
