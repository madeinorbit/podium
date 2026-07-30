/**
 * Handlers for the six LIBRARY CRUD contracts — create, revise, fork, publish,
 * assign — plus profileSave, which shares the file because it is the sixth
 * non-advance command and nothing but its policy differs in shape.
 *
 * The contracts' policies are L1 data in `@podium/commands`; these functions are
 * the only place that knows there is a `WorkflowsRepository` behind them. Every
 * authorization question goes to `ctx.access`; none is decided here.
 */

import { randomUUID } from 'node:crypto'
import type {
  ContractInput,
  workflowAssignContract,
  workflowCreateContract,
  workflowForkContract,
  workflowProfileSaveContract,
  workflowPublishContract,
  workflowReviseContract,
} from '@podium/commands'
import { unknownRevision, type WorkflowHandlerContext } from './context'

export function createHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowCreateContract>,
) {
  const { caller, deps, access, engine } = ctx
  const scopeRef = engine.scopeRef(input.scope, input.scopeRef)
  access.assertCreateScope(caller, input.scope, scopeRef)
  const now = deps.now()
  const workflowId = `wf_${randomUUID()}`
  deps.store.insertWorkflow({
    id: workflowId,
    name: input.name,
    description: input.description,
    scope: input.scope,
    scopeRef,
    actor: engine.actor(caller),
    now,
  })
  const revision = deps.store.insertRevision({
    id: `wfr_${randomUUID()}`,
    workflowId,
    instructions: input.instructions,
    steps: input.steps,
    actor: engine.actor(caller),
    now,
  })
  deps.store.appendEvent({
    workflowId,
    kind: 'workflow.created',
    actor: engine.actor(caller),
    payload: { revisionId: revision.id, scope: input.scope, scopeRef },
    now,
  })
  const workflow = deps.store.getWorkflow(workflowId)
  if (!workflow) throw new Error(`workflow creation lost ${workflowId}`)
  return { workflow, revision }
}

export function reviseHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowReviseContract>,
) {
  const { caller, deps, access, engine } = ctx
  access.assertWorkflowWrite(caller, input.workflowId)
  const now = deps.now()
  // REVISION IMMUTABILITY, unchanged: this APPENDS a version and never edits a
  // prior one in place, and publication is not a lock (POD-730 §2).
  const revision = deps.store.insertRevision({
    id: `wfr_${randomUUID()}`,
    workflowId: input.workflowId,
    instructions: input.instructions,
    steps: input.steps,
    actor: engine.actor(caller),
    now,
  })
  deps.store.appendEvent({
    workflowId: input.workflowId,
    kind: 'workflow.revised',
    actor: engine.actor(caller),
    payload: { revisionId: revision.id, version: revision.version },
    now,
  })
  return revision
}

export function forkHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowForkContract>,
) {
  const { caller, deps, access } = ctx
  const source = deps.store.getRevision(input.revisionId)
  // THE REVISION EXISTENCE LEAK, closed. POD-730 §10: an out-of-scope revision
  // id used to CONFIRM the revision existed (it resolved, then the workflow
  // read refused with a different message). Both outcomes now leave here with
  // the same string, so a revision id is no longer an oracle.
  if (!source) throw new Error(unknownRevision(input.revisionId))
  try {
    access.assertWorkflowRead(caller, source.workflowId)
  } catch {
    throw new Error(unknownRevision(input.revisionId))
  }
  return createHandler(ctx, {
    name: input.name,
    description: input.description,
    scope: input.scope,
    ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : {}),
    instructions: source.instructions,
    steps: source.steps,
  })
}

export function publishHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowPublishContract>,
) {
  const { caller, deps, access, engine } = ctx
  const revision = deps.store.getRevision(input.revisionId)
  if (!revision) throw new Error(unknownRevision(input.revisionId))
  const workflow = deps.store.getWorkflow(revision.workflowId)
  if (!workflow) throw new Error(`workflow revision ${revision.id} lost its workflow`)
  // ONE decision, where there used to be two. `assertWorkflowWrite` now refuses
  // a non-admin on a global workflow itself, which is exactly what the shipped
  // "approval required to publish a global workflow revision" check did for
  // this one command — so the brake is no longer a special case bolted beside
  // the guard, it IS the guard, and it now covers create and revise too.
  access.assertWorkflowWrite(caller, workflow.id)
  const now = deps.now()
  deps.store.publishRevision(revision.id, now)
  deps.store.appendEvent({
    workflowId: workflow.id,
    kind: 'workflow.published',
    actor: engine.actor(caller),
    payload: { revisionId: revision.id },
    now,
  })
  const published = deps.store.getRevision(revision.id)
  if (!published) throw new Error(`published workflow revision ${revision.id} disappeared`)
  return published
}

export function assignHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowAssignContract>,
) {
  const { caller, deps, access, engine } = ctx
  const revision = deps.store.getRevision(input.revisionId)
  if (!revision) throw new Error(unknownRevision(input.revisionId))
  try {
    access.assertWorkflowRead(caller, revision.workflowId)
  } catch {
    throw new Error(unknownRevision(input.revisionId))
  }
  // ORDER IS PINNED (POD-730 §1, line 361): the protected-write check runs
  // BEFORE the published-revision rule, so an unauthorized caller learns it is
  // unauthorized rather than learning which revisions are published.
  if (
    (input.targetKind === 'global' || input.targetKind === 'repository') &&
    access.principal(caller).role !== 'admin'
  ) {
    throw new Error(`approval required to change the ${input.targetKind} workflow default`)
  }
  if (
    (input.targetKind === 'global' || input.targetKind === 'repository') &&
    revision.publishedAt === null
  ) {
    throw new Error('shared workflow defaults require a published revision')
  }
  if (input.targetKind === 'issue') access.assertIssueScope(caller, input.targetId)
  if (
    input.targetKind === 'session' &&
    caller.actor.kind === 'session' &&
    caller.actor.id !== input.targetId &&
    !caller.overrideScope
  ) {
    throw new Error('agents may directly assign only their own session')
  }
  // PLACEMENT, at assign time (readiness §3.1.4 M5). Binding a workflow to a
  // session is placing work on whatever machine that session sits on, and `use`
  // is a code-execution boundary. Denied is never silently retargeted, and it
  // stays distinguishable from unreachable.
  if (input.targetKind === 'session') {
    access.assertMayPlaceOn(access.machineForSession(input.targetId))
  }
  const now = deps.now()
  const binding = deps.store.setBinding({ ...input, actor: engine.actor(caller), now })
  deps.store.appendEvent({
    workflowId: revision.workflowId,
    kind: 'workflow.assigned',
    actor: engine.actor(caller),
    payload: input,
    now,
  })
  return binding
}

export function profileSaveHandler(
  ctx: WorkflowHandlerContext,
  input: ContractInput<typeof workflowProfileSaveContract>,
) {
  const { caller, deps, access, engine } = ctx
  access.assertProfileWrite(caller, input.id)
  // The machine a profile PINS is the machine its runs will execute on, so the
  // `use` grant is checked when the pin is written as well as when it is used.
  // Checking only at launch would let a principal stage a binding it may not
  // run and hand it to someone who can.
  access.assertMayPlaceOn(input.machineId)
  const now = deps.now()
  return deps.store.upsertProfile({
    id: input.id ?? `wfp_${randomUUID()}`,
    name: input.name,
    accountId: input.accountId,
    machineId: input.machineId ?? null,
    harness: input.harness,
    model: input.model,
    effort: input.effort,
    actor: engine.actor(caller),
    now,
  })
}
