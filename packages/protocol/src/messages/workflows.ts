import {
  SessionIdField,
  WorkflowBindingTarget,
  WorkflowBindingWire,
  WorkflowGitObservation,
  WorkflowRevisionWire,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
  WorkflowRunStepWire,
  WorkflowScope,
  WorkflowStep,
  WorkflowStepEvidence,
  WorkflowWire,
} from '@podium/model'
import { z } from 'zod'

/**
 * THE WORKFLOW REQUEST ANSWERS (POD-1127, POD-6676).
 *
 * The entity schemas moved to `@podium/model` (`entities/workflow.ts`) when the
 * family joined `MetadataEntityKind` (POD-6676): that was the condition the
 * POD-1127 decision recorded here for the move. They are re-exported below, so
 * an importer of `@podium/protocol` reads the same names.
 *
 * What stays is what is NOT a record: the detail answer (a workflow with its
 * revisions), the run as `workflows.status` and the run commands answer it (its
 * revision embedded, its history attached), and the next-action packet.
 */
export {
  WorkflowBindingTarget,
  WorkflowBindingWire,
  WorkflowGitObservation,
  WorkflowRevisionWire,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
  WorkflowRunStepWire,
  WorkflowScope,
  WorkflowStep,
  WorkflowStepEvidence,
  WorkflowWire,
}

export const WorkflowDetailWire = z.object({
  workflow: WorkflowWire,
  revisions: z.array(WorkflowRevisionWire),
})
export type WorkflowDetailWire = z.infer<typeof WorkflowDetailWire>

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
