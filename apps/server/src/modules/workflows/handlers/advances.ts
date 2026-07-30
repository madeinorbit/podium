/**
 * Handlers for the five RUN ADVANCES — checkpoint, assignStep, skip, retry,
 * adopt.
 *
 * The state machine's invariants are preserved verbatim across the move, and
 * POD-730's suite is the oracle for that claim:
 *
 *   - only the CURRENT linear step may be checkpointed, assigned or skipped;
 *   - no retry once a LATER step has left pending (active is enough; a skipped
 *     later step also locks it);
 *   - adopt only on an ACTIVE or BLOCKED run, and it validates everything
 *     BEFORE superseding, so a failed adopt leaves the live run untouched;
 *   - the pinned-workflow guard on `prepareStart`.
 *
 * What CHANGED is authorization (one decision, in `ctx.access`) and delivery
 * (the run-scoped idempotency the registry applies before any of these runs).
 */

import type {
  ContractInput,
  workflowAdoptContract,
  workflowAssignStepContract,
  workflowCheckpointContract,
  workflowRetryContract,
  workflowSkipContract,
} from '@podium/commands'
import { unknownRevision, type WorkflowHandlerContext } from './context'

export function checkpointHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowCheckpointContract>,
) {
  const { caller, deps, access, engine } = ctx
  const run = engine.runFor(caller, input.runId)
  const now = deps.now()
  if (run.steps.length === 0) {
    // The prompt-only arm: no steps, so the checkpoint moves the RUN.
    access.assertCoordinator(run, caller)
    if (input.status === 'complete') deps.store.updateRunStatus(run.id, 'complete', now)
    else deps.store.updateRunStatus(run.id, input.status === 'blocked' ? 'blocked' : 'active', null)
    deps.store.appendEvent({
      workflowId: run.revision.workflowId,
      runId: run.id,
      kind: `workflow.run_${input.status}`,
      actor: engine.actor(caller),
      payload: { summary: input.summary, evidence: input.evidence },
      now,
    })
    return engine.nextPacket(
      run.id,
      input.status === 'complete' ? 'Workflow complete.' : `Workflow ${input.status}.`,
    )
  }
  const current = engine.currentStep(run)
  if (!current) throw new Error('workflow has no remaining step')
  const step = input.stepId
    ? run.steps.find((candidate) => candidate.stepId === input.stepId)
    : current
  if (!step) throw new Error(`workflow has no step ${input.stepId}`)
  if (step.stepId !== current.stepId)
    throw new Error(`step ${step.stepId} is not the current linear step`)
  if (!access.mayCheckpoint(run, step, caller)) {
    throw new Error('session is not assigned to this workflow step')
  }
  const observation = input.observation ?? null
  const warnings = engine.observationWarningsForRun(run, step, caller, input.status, observation)
  const assignedSessionId =
    step.assignedSessionId ?? (caller.actor.kind === 'session' ? caller.actor.id : null)
  deps.store.updateStep({
    runId: run.id,
    stepId: step.stepId,
    status: input.status,
    assignedSessionId,
    summary: input.summary,
    evidence: input.evidence,
    observation,
    warnings,
    startedAt: step.startedAt ?? now,
    completedAt: input.status === 'complete' ? now : null,
  })
  const updatedSteps = deps.store.getRunSteps(run.id)
  const remaining = updatedSteps.find((candidate) => candidate.status === 'pending')
  if (input.status === 'blocked') deps.store.updateRunStatus(run.id, 'blocked', null)
  else if (input.status === 'complete' && !remaining)
    deps.store.updateRunStatus(run.id, 'complete', now)
  else deps.store.updateRunStatus(run.id, 'active', null)
  deps.store.appendEvent({
    workflowId: run.revision.workflowId,
    runId: run.id,
    kind: `workflow.step_${input.status}`,
    actor: engine.actor(caller),
    payload: { stepId: step.stepId, summary: input.summary, warnings },
    now,
  })
  const worker = caller.actor.id && caller.actor.id !== run.coordinatorSessionId
  if (worker && deps.notifyCoordinator) {
    deps.notifyCoordinator(
      run.coordinatorSessionId,
      `Workflow step "${step.title}" ${input.status}: ${input.summary || '(no summary)'}`,
    )
  }
  const message =
    input.status === 'complete'
      ? remaining
        ? `Step complete. Next: ${remaining.title}`
        : 'Workflow complete.'
      : input.status === 'blocked'
        ? 'Step blocked. Coordinator attention is required.'
        : `Step active: ${step.title}`
  return engine.nextPacket(run.id, message, warnings)
}

export function assignStepHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowAssignStepContract>,
) {
  const { caller, deps, access, engine } = ctx
  const run = engine.runFor(caller, input.runId)
  access.assertCoordinator(run, caller)
  const current = engine.currentStep(run)
  if (!current || current.stepId !== input.stepId)
    throw new Error('only the current step may be assigned')
  // PLACEMENT (readiness §3.1.4 M5). This is the assign-time half of the check;
  // the apply-time half runs when the step is checkpointed. Both are needed
  // because a run is long-lived and a `use` grant can be revoked between them.
  if (input.sessionId !== null) {
    access.assertMayPlaceOn(access.machineForSession(input.sessionId))
  }
  deps.store.assignStep(run.id, input.stepId, input.sessionId)
  deps.store.appendEvent({
    workflowId: run.revision.workflowId,
    runId: run.id,
    kind: 'workflow.step_assigned',
    actor: engine.actor(caller),
    payload: { stepId: input.stepId, sessionId: input.sessionId },
    now: deps.now(),
  })
  return engine.nextPacket(
    run.id,
    input.sessionId ? `Step assigned to ${input.sessionId}.` : 'Step unassigned.',
  )
}

export function skipHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowSkipContract>,
) {
  const { caller, deps, access, engine } = ctx
  const run = engine.runFor(caller, input.runId)
  access.assertCoordinator(run, caller)
  const current = engine.currentStep(run)
  if (!current || current.stepId !== input.stepId)
    throw new Error('only the current step may be skipped')
  const now = deps.now()
  deps.store.updateStep({
    runId: run.id,
    stepId: current.stepId,
    status: 'skipped',
    assignedSessionId: current.assignedSessionId,
    summary: input.reason,
    evidence: current.evidence,
    observation: current.observation,
    warnings: current.warnings,
    startedAt: current.startedAt,
    completedAt: now,
  })
  const remaining = deps.store.getRunSteps(run.id).find((step) => step.status === 'pending')
  if (!remaining) deps.store.updateRunStatus(run.id, 'complete', now)
  else deps.store.updateRunStatus(run.id, 'active', null)
  deps.store.appendEvent({
    workflowId: run.revision.workflowId,
    runId: run.id,
    kind: 'workflow.step_skipped',
    actor: engine.actor(caller),
    payload: { stepId: current.stepId, reason: input.reason },
    now,
  })
  return engine.nextPacket(
    run.id,
    remaining ? `Skipped. Next: ${remaining.title}` : 'Workflow complete.',
  )
}

export function retryHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowRetryContract>,
) {
  const { caller, deps, access, engine } = ctx
  const run = engine.runFor(caller, input.runId)
  access.assertCoordinator(run, caller)
  const target = run.steps.find((step) => step.stepId === input.stepId)
  if (!target) throw new Error(`workflow has no step ${input.stepId}`)
  const laterStarted = run.steps.some(
    (step) => step.position > target.position && step.status !== 'pending',
  )
  if (laterStarted) throw new Error('cannot retry a step after a later step has started')
  deps.store.resetStep(run.id, target.stepId)
  deps.store.updateRunStatus(run.id, 'active', null)
  deps.store.appendEvent({
    workflowId: run.revision.workflowId,
    runId: run.id,
    kind: 'workflow.step_retried',
    actor: engine.actor(caller),
    payload: { stepId: target.stepId },
    now: deps.now(),
  })
  return engine.nextPacket(run.id, `Retry ready: ${target.title}`)
}

export function adoptHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowAdoptContract>,
) {
  const { caller, deps, access, engine } = ctx
  const current = engine.runFor(caller, input.runId)
  access.assertCoordinator(current, caller)
  if (current.status !== 'active' && current.status !== 'blocked')
    throw new Error('only an active workflow run may adopt a revision')
  const coordinatorSessionId = caller.actor.id ?? current.coordinatorSessionId
  const session = deps.session(coordinatorSessionId)
  if (!session) throw new Error('coordinator session no longer exists')
  const revision = deps.store.getRevision(input.revisionId)
  if (!revision) throw new Error(unknownRevision(input.revisionId))
  try {
    access.assertWorkflowRead(caller, revision.workflowId)
  } catch {
    throw new Error(unknownRevision(input.revisionId))
  }
  const issueId = current.subjectKind === 'issue' ? current.subjectId : undefined
  // EVERYTHING VALIDATES BEFORE THE SUPERSEDE (POD-730 §8). The order below is
  // the invariant, not an accident of how it was written: a failure at any of
  // these four points must leave the live run exactly as it was.
  engine.assertRevisionMatchesStart(revision, {
    sessionId: session.sessionId,
    cwd: session.cwd,
    ...(issueId ? { issueId } : {}),
  })
  if (input.startStepId && !revision.steps.some((step) => step.id === input.startStepId))
    throw new Error(`workflow has no step ${input.startStepId}`)
  const now = deps.now()
  deps.store.updateRunStatus(current.id, 'superseded', now)
  return engine.startRun({
    sessionId: session.sessionId,
    cwd: session.cwd,
    ...(issueId ? { issueId } : {}),
    revisionId: input.revisionId,
    supersedesRunId: current.id,
    ...(input.startStepId ? { startStepId: input.startStepId } : {}),
  })
}
