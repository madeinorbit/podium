import { randomUUID } from 'node:crypto'
import {
  type AdvanceIdempotencyPort,
  workflowAdoptInput,
  workflowAssignInput,
  workflowAssignStepInput,
  workflowCheckpointInput,
  workflowCreateInput,
  workflowForkInput,
  workflowProfileSaveInput,
  workflowPublishInput,
  workflowRetryInput,
  workflowReviseInput,
  workflowSkipInput,
} from '@podium/commands'
import { AgentKind } from '@podium/model'
import {
  type ExecutionProfileWire,
  type WorkflowGitObservation as GitObservation,
  WorkflowBindingTarget,
  WorkflowGitObservation,
  type WorkflowNextActionWire,
  type WorkflowRevisionWire,
  type WorkflowRunStepWire,
  type WorkflowRunWire,
  WorkflowScope,
  WorkflowStep,
  WorkflowStepEvidence,
  type WorkflowWire,
} from '@podium/protocol'
import { z } from 'zod'
import type { Capability } from '../../issue-authz'
import type { IssueRow } from '../../store/types'
import type { WorkflowActor, WorkflowRunRow, WorkflowsRepository } from '../../store/workflows'
import type {
  adoptHandler,
  assignStepHandler,
  checkpointHandler,
  retryHandler,
  skipHandler,
} from './handlers/advances'
import {
  NO_RUN,
  WorkflowAccess,
  type WorkflowHandlerContext,
  type WorkflowPolicyPorts,
} from './handlers/context'
import type {
  assignHandler,
  createHandler,
  forkHandler,
  profileSaveHandler,
  publishHandler,
  reviseHandler,
} from './handlers/library'
import { dispatchWorkflowCommand, type WorkflowProcName } from './registry'

const actorInput = z.object({}).passthrough()
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
const revisionBody = z.object({
  instructions: z.string().default(''),
  steps: workflowSteps.default([]),
})

/**
 * The transport-facing input table.
 *
 * THE ELEVEN MUTATIONS NOW POINT AT THEIR CONTRACTS (POD-731). They are not
 * restated here: a second copy of a schema is a second thing to edit, and the
 * copy that does not get edited is the one a transport validates with. What is
 * still written out below is `list`, `get`, `bindings`, `profiles`, `runs`,
 * `prime` and `status` — the QUERIES, which POD-732 folds in with the cutover.
 */
export const workflowInputs = {
  list: z.object({
    includeArchived: z.boolean().optional(),
    scope: WorkflowScope.optional(),
    scopeRef: z.string().optional(),
  }),
  get: z.object({ id: z.string().min(1) }),
  create: workflowCreateInput,
  revise: workflowReviseInput,
  fork: workflowForkInput,
  publish: workflowPublishInput,
  bindings: actorInput,
  assign: workflowAssignInput,
  profiles: actorInput,
  profileSave: workflowProfileSaveInput,
  runs: z.object({ includeTerminal: z.boolean().optional() }),
  prime: actorInput,
  status: z.object({ runId: z.string().optional() }),
  checkpoint: workflowCheckpointInput,
  assignStep: workflowAssignStepInput,
  skip: workflowSkipInput,
  retry: workflowRetryInput,
  adopt: workflowAdoptInput,
} as const

export interface WorkflowCaller {
  actor: WorkflowActor
  capability?: Capability
  overrideScope?: boolean
  /** Operator calls and approved server-side operations may change protected
   * global/repository defaults and publish global revisions.
   *
   * POD-731 narrowed what this MEANS without changing who sets it: it is the
   * ACCOUNT GRADE (`admin`), and a grade decides the admin-grade paths — the
   * global library, execution profiles — rather than short-circuiting every
   * guard on the surface. See `workflowPrincipal`. */
  protectedWrite?: boolean
  /**
   * THE OTHER HALF OF ADR 9 D5 A3's attribution pair: which HUMAN this actor
   * acts for, resolved from the delegation record by the transport and never
   * from payload.
   *
   * `undefined` means "the transport did not resolve one", which today is every
   * caller and resolves to the single human. `null` means REVOKED — A1's
   * whole revocation semantics, and the reason it is a distinct value rather
   * than an absence: a long-lived unattended run whose delegating human has
   * been revoked must stop advancing at its next apply, with no reaper to
   * write and none to forget.
   */
  onBehalfOf?: string | null
}

interface SessionInfo {
  sessionId: string
  cwd: string
  issueId?: string
  agentKind: string
  machineId?: string
}

/**
 * What this service needs to know about an issue: its expected worktree, so a
 * step's observed worktree can be checked against it. A narrow R5 port, composed
 * from {@link IssueRow} rather than restated (POD-367).
 *
 * POD-364's inventory (#14) called this a drifted duplicate of `FocusIssueInfo`
 * and section 6.4 said it deletes in favour of it. It is neither. `FocusIssueInfo`
 * is `{seq,title,stage,repoPath}` for a superagent prompt line; this is a
 * worktree-placement check. They share `repoPath` and nothing else, and ADR 4
 * keeps narrow ports distinct rather than collapsing them into one shape that
 * carries members neither caller needs. So both are re-derived as `Pick`s and
 * neither is deleted; the inventory verdict is corrected, not followed.
 *
 * The three members that WERE here — `id`, `repoId`, `repoPath` — had no reader
 * at any call site and are gone with the wiring that supplied them.
 */
type IssueInfo = Pick<IssueRow, 'worktreePath'>

export interface WorkflowServiceDeps {
  store: WorkflowsRepository
  now(): string
  session(sessionId: string): SessionInfo | undefined
  issue(issueId: string): IssueInfo | undefined
  repoIdForPath(path: string): string | null
  notifyCoordinator?(sessionId: string, text: string): void
}

function globalTargetId(): string {
  return ''
}

/**
 * What a HANDLER may reach on the engine — the run arithmetic and the state
 * machine, and nothing that decides authorization.
 *
 * A named interface rather than the class itself, for two reasons that both
 * matter to the next issue. It is the LIST of what still has to move when
 * POD-732 finishes the cut, written where a reader will find it; and it keeps
 * the handlers unable to reach a guard by accident, because there is no guard
 * on it to reach. Authorization arrives through `ctx.access` or not at all.
 */
export interface WorkflowEngine {
  actor(caller: WorkflowCaller): WorkflowActor
  scopeRef(scope: z.infer<typeof WorkflowScope>, raw: string | null | undefined): string | null
  currentStep(run: WorkflowRunWire): WorkflowRunStepWire | null
  nextPacket(runId: string, message: string, warnings?: string[]): WorkflowNextActionWire
  /** Resolves a run AND takes its visibility decision — an unknown id and an
   *  invisible one leave by the same throw (ADR 3 Amendment 1 D20.2). */
  runFor(caller: WorkflowCaller, requested?: string): WorkflowRunWire
  observationWarningsForRun(
    run: WorkflowRunWire,
    step: WorkflowRunStepWire,
    caller: WorkflowCaller,
    status: 'active' | 'blocked' | 'complete',
    observation: GitObservation | null,
  ): string[]
  assertRevisionMatchesStart(
    revision: WorkflowRevisionWire,
    input: { sessionId: string; cwd: string; issueId?: string },
  ): void
  startRun(input: {
    sessionId: string
    cwd: string
    issueId?: string
    revisionId: string
    supersedesRunId?: string
    startStepId?: string
  }): WorkflowRunWire
}

export class WorkflowService implements WorkflowEngine {
  constructor(
    private readonly deps: WorkflowServiceDeps,
    ports?: WorkflowPolicyPorts & { ledger?: AdvanceIdempotencyPort },
  ) {
    this.access = new WorkflowAccess(deps, ports)
    this.ledger = ports?.ledger
  }

  /**
   * The run-scoped idempotency ledger (`applied_mutations`, as a port).
   *
   * ABSENT is not "idempotency off". The framework's other half — refusing an
   * advance that names neither a step nor a mutation id — runs regardless, and
   * it is the half that closes POD-730 §6's double-advance. The ledger adds
   * at-most-once for callers that DO mint a delivery id; without it such a
   * caller simply gets today's behaviour for its replay, which for every
   * advance except `retry` is already idempotent in effect.
   */
  private readonly ledger: AdvanceIdempotencyPort | undefined

  actor(caller: WorkflowCaller): WorkflowActor {
    return caller.actor
  }

  sessionFor(caller: WorkflowCaller): SessionInfo | undefined {
    return caller.actor.kind === 'session' && caller.actor.id
      ? this.deps.session(caller.actor.id)
      : undefined
  }

  scopeRef(scope: z.infer<typeof WorkflowScope>, raw: string | null | undefined): string | null {
    if (scope === 'global') return null
    if (!raw) throw new Error(`${scope} workflows require scopeRef`)
    return raw
  }

  /**
   * THE SIXTEEN GUARDS ARE GONE FROM HERE (POD-731).
   *
   * Every authorization question this class used to answer inline — the four
   * scope guards, `canReadWorkflow`, `assertCoordinator`, `checkpoint`'s allowed
   * check, `profileSave`'s inverse guard, and the three read-shaped branches in
   * `bindings`, `runs` and `runFor` — is now one call into {@link
   * WorkflowAccess}, which takes one decision against a real principal.
   *
   * What survives on this class is the STATE MACHINE and the run arithmetic.
   * That split is deliberate and is the reviewable unit: authorization was the
   * part that was wrong, and moving the state machine in the same diff would
   * have made it impossible to grade against POD-730's oracle. POD-732 does the
   * cutover and the deletion.
   */
  readonly access: WorkflowAccess

  assertWorkflowRead(caller: WorkflowCaller, workflowId: string): WorkflowWire {
    return this.access.assertWorkflowRead(caller, workflowId)
  }

  canReadWorkflow(caller: WorkflowCaller, workflow: WorkflowWire): boolean {
    return this.access.canReadWorkflow(caller, workflow)
  }

  list(input: z.infer<(typeof workflowInputs)['list']>, caller: WorkflowCaller) {
    return this.deps.store
      .listWorkflows(input)
      .filter((workflow) => this.canReadWorkflow(caller, workflow))
  }

  get(input: z.infer<(typeof workflowInputs)['get']>, caller: WorkflowCaller) {
    // ONE site, ONE message for both "no such workflow" and "not yours"
    // (ADR 3 Amendment 1 D20.2) — `assertWorkflowRead` is where that lives, so
    // this no longer resolves the row and then refuses it with a second string.
    const workflow = this.access.assertWorkflowRead(caller, input.id)
    return { workflow, revisions: this.deps.store.listRevisions(input.id) }
  }

  create(
    input: z.infer<(typeof workflowInputs)['create']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof createHandler> {
    return this.run('create', input, caller)
  }

  revise(
    input: z.infer<(typeof workflowInputs)['revise']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof reviseHandler> {
    return this.run('revise', input, caller)
  }

  fork(
    input: z.infer<(typeof workflowInputs)['fork']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof forkHandler> {
    return this.run('fork', input, caller)
  }

  publish(
    input: z.infer<(typeof workflowInputs)['publish']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof publishHandler> {
    return this.run('publish', input, caller)
  }

  /** QUERY, not a mutation — and one of the three read-shaped operator branches
   *  POD-730 pinned for exactly this reason. It returned EVERY binding in the
   *  instance; it now asks the same decision every mutation asks. */
  bindings(_input: z.infer<(typeof workflowInputs)['bindings']>, caller: WorkflowCaller) {
    return this.access.visibleBindings(caller, this.deps.store.listBindings())
  }

  assign(
    input: z.infer<(typeof workflowInputs)['assign']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof assignHandler> {
    return this.run('assign', input, caller)
  }

  /** QUERY. Had NO gate at all and listed every profile — with its
   *  `accountId`, which names managed credentials — to any caller. */
  profiles(_input: z.infer<(typeof workflowInputs)['profiles']>, caller: WorkflowCaller) {
    return this.access.visibleProfiles(caller, this.deps.store.listProfiles())
  }

  profileSave(
    input: z.infer<(typeof workflowInputs)['profileSave']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof profileSaveHandler> {
    return this.run('profileSave', input, caller)
  }

  /**
   * Resolve the immutable execution-profile snapshot attached to a run step.
   * Standalone profile launches use the current shared profile; launches that
   * identify a run + step use the snapshot pinned when that run started.
   */
  executionProfileForLaunch(input: {
    profileId: string
    runId?: string
    stepId?: string
  }): ExecutionProfileWire & { harness: AgentKind } {
    let profile: ExecutionProfileWire | null
    if (input.runId && input.stepId) {
      const run = this.deps.store.getRun(input.runId)
      if (!run) throw new Error(`unknown workflow run: ${input.runId}`)
      const step = this.deps.store
        .getRunSteps(run.id)
        .find((candidate) => candidate.stepId === input.stepId)
      if (!step) throw new Error(`workflow run ${run.id} has no step ${input.stepId}`)
      if (step.executionProfileId !== input.profileId) {
        throw new Error(
          `workflow step ${input.stepId} requires ${step.executionProfileId ?? 'no execution profile'}, not ${input.profileId}`,
        )
      }
      profile = step.executionProfileSnapshot
      if (!profile) {
        throw new Error(`execution profile snapshot ${input.profileId} is unavailable`)
      }
    } else {
      profile = this.deps.store.getProfile(input.profileId)
      if (!profile) throw new Error(`unknown execution profile: ${input.profileId}`)
    }
    // PLACEMENT AT APPLY (readiness §3.1.4 M5, and the second half of the check
    // `assignStep` / `profileSave` make at write time).
    //
    // BOTH are needed and neither is redundant. A run is long-lived and
    // unattended: the grant that authorized the assignment can be revoked
    // before the step is ever launched, and the snapshot pinned to the step is
    // correct for REPRODUCIBILITY but must never become the model for
    // AUTHORIZATION (POD-730 §4). So the machine is re-checked here, against
    // the current grants, every time work is actually placed.
    this.access.assertMayPlaceOn(profile.machineId)
    const harness = AgentKind.safeParse(profile.harness)
    if (!harness.success) {
      throw new Error(`execution profile ${profile.id} has unsupported harness ${profile.harness}`)
    }
    return { ...profile, harness: harness.data }
  }

  liveRunForSession(sessionId: string): WorkflowRunRow | null {
    const direct = this.deps.store.findLiveRunForSession(sessionId)
    if (direct) return direct
    const issueId = this.deps.session(sessionId)?.issueId
    return issueId ? this.deps.store.findLiveRun('issue', issueId) : null
  }

  /**
   * QUERY, and the second of the three read-shaped operator branches. It
   * returned every run in the INSTANCE for an operator; a session got only its
   * own live run.
   *
   * BOTH SHAPES SURVIVE, and only the authorization changed. The session arm is
   * still the LIVE run and still ignores `includeTerminal` — POD-730 pins that,
   * and widening a session's list to its own completed runs is a change no
   * criterion here asks for. What changed is that each arm now ends at
   * `canSeeRun`, the same decision `runFor` takes, so a run you cannot open is
   * a run you cannot list rather than two rules that could disagree.
   */
  runs(input: z.infer<(typeof workflowInputs)['runs']>, caller: WorkflowCaller) {
    if (caller.actor.kind === 'session' && caller.actor.id !== null) {
      const live = this.liveRunForSession(caller.actor.id)
      if (!live) return []
      const run = this.toRun(live)
      return this.access.canSeeRun(caller, run) ? [run] : []
    }
    return this.access.visibleRuns(
      caller,
      this.deps.store.listRuns(input.includeTerminal ?? false).map((row) => this.toRun(row)),
    )
  }

  assertRevisionMatchesStart(
    revision: WorkflowRevisionWire,
    input: { sessionId: string; cwd: string; issueId?: string },
  ): void {
    const workflow = this.deps.store.getWorkflow(revision.workflowId)
    if (!workflow) throw new Error(`workflow revision ${revision.id} lost its workflow`)
    if (workflow.scope === 'global') return
    if (workflow.scope === 'repository' && workflow.scopeRef === this.deps.repoIdForPath(input.cwd))
      return
    if (
      workflow.scope === 'task' &&
      (workflow.scopeRef === input.sessionId || workflow.scopeRef === input.issueId)
    )
      return
    throw new Error(`workflow revision ${revision.id} is outside the requested start scope`)
  }

  resolveRevision(input: {
    sessionId: string
    cwd: string
    issueId?: string
    explicitRevisionId?: string
  }): WorkflowRevisionWire | null {
    if (input.explicitRevisionId) {
      const revision = this.deps.store.getRevision(input.explicitRevisionId)
      if (!revision) throw new Error(`unknown workflow revision: ${input.explicitRevisionId}`)
      this.assertRevisionMatchesStart(revision, input)
      return revision
    }
    const repoId = this.deps.repoIdForPath(input.cwd)
    const candidates = [
      this.deps.store.getBinding('session', input.sessionId),
      input.issueId ? this.deps.store.getBinding('issue', input.issueId) : null,
      repoId ? this.deps.store.getBinding('repository', repoId) : null,
      this.deps.store.getBinding('global', globalTargetId()),
    ]
    const binding = candidates.find((candidate) => candidate !== null)
    return binding ? this.deps.store.getRevision(binding.revisionId) : null
  }

  prepareStart(input: {
    sessionId: string
    cwd: string
    issueId?: string
    explicitRevisionId?: string
  }): { revision: WorkflowRevisionWire; prompt: string } | null {
    const existing = input.issueId ? this.deps.store.findLiveRun('issue', input.issueId) : null
    if (existing) {
      if (input.explicitRevisionId && input.explicitRevisionId !== existing.revisionId)
        throw new Error('the issue already has a pinned workflow; adopt a new revision explicitly')
      const revision = this.deps.store.getRevision(existing.revisionId)
      if (!revision) throw new Error(`workflow run ${existing.id} lost its revision`)
      return { revision, prompt: this.renderRevisionPrompt(revision) }
    }
    const revision = this.resolveRevision(input)
    if (!revision) return null
    return { revision, prompt: this.renderRevisionPrompt(revision) }
  }

  prepareExistingSession(input: {
    sessionId: string
    issueId?: string
  }): { revision: WorkflowRevisionWire; prompt: string } | null {
    const existing =
      this.deps.store.findLiveRunForSession(input.sessionId) ??
      (input.issueId ? this.deps.store.findLiveRun('issue', input.issueId) : null)
    if (!existing) return null
    const revision = this.deps.store.getRevision(existing.revisionId)
    if (!revision) throw new Error(`workflow run ${existing.id} lost its revision`)
    return { revision, prompt: this.renderRevisionPrompt(revision) }
  }

  startRun(input: {
    sessionId: string
    cwd: string
    issueId?: string
    revisionId: string
    supersedesRunId?: string
    startStepId?: string
  }): WorkflowRunWire {
    const subjectKind = input.issueId ? 'issue' : 'session'
    const subjectId = input.issueId ?? input.sessionId
    const existing = this.deps.store.findLiveRun(subjectKind, subjectId)
    if (existing && !input.supersedesRunId) return this.toRun(existing)
    const revision = this.deps.store.getRevision(input.revisionId)
    if (!revision) throw new Error(`unknown workflow revision: ${input.revisionId}`)
    const startPosition = input.startStepId
      ? revision.steps.findIndex((step) => step.id === input.startStepId)
      : 0
    if (input.startStepId && startPosition < 0)
      throw new Error(`workflow has no step ${input.startStepId}`)
    const now = this.deps.now()
    const run: WorkflowRunRow = {
      id: `wrun_${randomUUID()}`,
      subjectKind,
      subjectId,
      coordinatorSessionId: input.sessionId,
      revisionId: revision.id,
      status: 'active',
      supersedesRunId: input.supersedesRunId ?? null,
      startedAt: now,
      completedAt: null,
    }
    this.deps.store.insertRun({
      run,
      steps: revision.steps.map((step) => ({
        ...step,
        profile: step.executionProfileId
          ? this.deps.store.getProfile(step.executionProfileId)
          : null,
      })),
    })
    if (input.startStepId && startPosition > 0) {
      const steps = this.deps.store.getRunSteps(run.id)
      for (const step of steps.filter((candidate) => candidate.position < startPosition)) {
        this.deps.store.updateStep({
          runId: run.id,
          stepId: step.stepId,
          status: 'skipped',
          assignedSessionId: null,
          summary: 'Skipped when adopting workflow',
          evidence: { summary: '', tests: [], artifacts: [] },
          observation: null,
          warnings: [],
          startedAt: null,
          completedAt: now,
        })
      }
    }
    this.deps.store.appendEvent({
      workflowId: revision.workflowId,
      runId: run.id,
      kind: input.supersedesRunId ? 'workflow.run_adopted' : 'workflow.run_started',
      actor: { kind: 'session', id: input.sessionId },
      payload: { revisionId: revision.id, subjectKind, subjectId, startStepId: input.startStepId },
      now,
    })
    const inserted = this.deps.store.getRun(run.id)
    if (!inserted) throw new Error(`workflow run ${run.id} was not persisted`)
    return this.toRun(inserted)
  }

  toRun(row: WorkflowRunRow): WorkflowRunWire {
    const revision = this.deps.store.getRevision(row.revisionId)
    if (!revision) throw new Error(`workflow run ${row.id} lost revision ${row.revisionId}`)
    return {
      id: row.id,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      coordinatorSessionId: row.coordinatorSessionId,
      revision,
      status: row.status,
      supersedesRunId: row.supersedesRunId,
      steps: this.deps.store.getRunSteps(row.id),
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }
  }

  runFor(caller: WorkflowCaller, requested?: string): WorkflowRunWire {
    const row = requested
      ? this.deps.store.getRun(requested)
      : caller.actor.id
        ? this.liveRunForSession(caller.actor.id)
        : null
    // THE CONSISTENT-ERROR RULE, by construction (ADR 3 Amendment 1 D20.2).
    //
    // An unknown run id and a run the principal may not see leave by the SAME
    // throw with the SAME message. POD-730 §10 pinned these as two outcomes —
    // `no active workflow run for this session` against `workflow run is
    // outside this session` — the second of which confirms the run exists.
    // There is now one site and one string, so they cannot drift back apart.
    if (!row) throw new Error(NO_RUN)
    const run = this.toRun(row)
    if (!this.access.canSeeRun(caller, run)) throw new Error(NO_RUN)
    return run
  }

  status(input: z.infer<(typeof workflowInputs)['status']>, caller: WorkflowCaller) {
    return this.runFor(caller, input.runId)
  }

  prime(_input: z.infer<(typeof workflowInputs)['prime']>, caller: WorkflowCaller): string {
    if (!caller.actor.id) return 'No workflow is attached to this operator context.'
    const row = this.liveRunForSession(caller.actor.id)
    if (!row) return 'No workflow is attached to this session.'
    return this.renderRunPrime(this.toRun(row), caller.actor.id)
  }

  currentStep(run: WorkflowRunWire): WorkflowRunStepWire | null {
    return (
      run.steps.find((step) => step.status === 'active' || step.status === 'blocked') ??
      run.steps.find((step) => step.status === 'pending') ??
      null
    )
  }

  nextPacket(runId: string, message: string, warnings: string[] = []): WorkflowNextActionWire {
    const row = this.deps.store.getRun(runId)
    if (!row) throw new Error(`workflow run ${runId} disappeared`)
    const run = this.toRun(row)
    const current = this.currentStep(run)
    return { run, currentStep: current, nextStep: current, message, warnings }
  }

  checkpoint(
    input: z.infer<(typeof workflowInputs)['checkpoint']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof checkpointHandler> {
    return this.run('checkpoint', input, caller)
  }

  observationWarningsForRun(
    run: WorkflowRunWire,
    step: WorkflowRunStepWire,
    caller: WorkflowCaller,
    status: 'active' | 'blocked' | 'complete',
    observation: GitObservation | null,
  ): string[] {
    const warnings: string[] = []
    const session = caller.actor.id ? this.deps.session(caller.actor.id) : undefined
    const profile = step.executionProfileSnapshot
    if (step.executionProfileId && !profile) {
      warnings.push(`execution profile ${step.executionProfileId} is unavailable`)
    }
    if (profile && session) {
      if (profile.harness !== session.agentKind) {
        warnings.push(
          `expected execution profile ${profile.name} (${profile.harness}), used ${session.agentKind}`,
        )
      }
      if (profile.machineId && profile.machineId !== session.machineId) {
        warnings.push(
          `expected machine ${profile.machineId}, used ${session.machineId ?? 'unknown'}`,
        )
      }
    }
    if (status === 'complete' && observation?.dirty === true) {
      warnings.push('step completed with uncommitted worktree changes')
    }
    if (run.subjectKind === 'issue') {
      const issue = this.deps.issue(run.subjectId)
      if (
        issue?.worktreePath &&
        observation?.worktree &&
        issue.worktreePath !== observation.worktree
      ) {
        warnings.push(
          `expected issue worktree ${issue.worktreePath}, observed ${observation.worktree}`,
        )
      }
    }
    return warnings
  }

  assignStep(
    input: z.infer<(typeof workflowInputs)['assignStep']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof assignStepHandler> {
    return this.run('assignStep', input, caller)
  }

  skip(
    input: z.infer<(typeof workflowInputs)['skip']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof skipHandler> {
    return this.run('skip', input, caller)
  }

  retry(
    input: z.infer<(typeof workflowInputs)['retry']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof retryHandler> {
    return this.run('retry', input, caller)
  }

  adopt(
    input: z.infer<(typeof workflowInputs)['adopt']>,
    caller: WorkflowCaller,
  ): ReturnType<typeof adoptHandler> {
    return this.run('adopt', input, caller)
  }

  /**
   * THE BRIDGE to the contract+handler path (POD-731).
   *
   * Every one of the eleven mutations above is now three lines that end here:
   * the contract's schema validates, the framework applies the run-scoped
   * idempotency, the handler runs. Nothing on this class validates or
   * authorizes a mutation any more.
   *
   * The methods survive as thin shims for exactly one issue's worth of time.
   * They are what lets POD-730's characterization suite — 88 tests written
   * against `service.checkpoint(input, caller)` — drive the NEW path unedited,
   * which is the only way "behaviour-preserving" can be a measurement rather
   * than a claim. POD-732 deletes them along with `workflowInputs` and
   * `dispatch`.
   */
  private run<T>(proc: WorkflowProcName, input: unknown, caller: WorkflowCaller): T {
    const ctx: WorkflowHandlerContext = {
      caller,
      deps: this.deps,
      access: this.access,
      engine: this,
    }
    return dispatchWorkflowCommand(proc, ctx, input, {
      ...(this.ledger ? { ledger: this.ledger } : {}),
      validated: true,
    }) as T
  }

  dispatch(caller: WorkflowCaller, proc: string, raw: unknown): Promise<unknown> | undefined {
    if (!Object.hasOwn(workflowInputs, proc)) return undefined
    const schema = workflowInputs[proc as keyof typeof workflowInputs]
    const input = schema.parse(raw ?? {}) as never
    const handler = this[proc as keyof WorkflowService]
    if (typeof handler !== 'function') return undefined
    return Promise.resolve(
      (handler as (input: never, caller: WorkflowCaller) => unknown).call(this, input, caller),
    )
  }

  renderRevisionPrompt(revision: WorkflowRevisionWire): string {
    const workflow = this.deps.store.getWorkflow(revision.workflowId)
    const heading = workflow?.name ?? revision.workflowId
    const steps = revision.steps.length
      ? `\n\nOrdered steps:\n${revision.steps
          .map(
            (step, index) =>
              `${index + 1}. ${step.title}${step.instructions ? ` — ${step.instructions}` : ''}`,
          )
          .join('\n')}`
      : ''
    return [
      `# Podium workflow: ${heading} (revision ${revision.version})`,
      revision.instructions,
      steps,
      '',
      'Follow this workflow while completing the task. Run `podium workflow prime` for current context and use `podium workflow checkpoint` to report progress.',
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  renderRunPrime(run: WorkflowRunWire, sessionId: string): string {
    const workflow = this.deps.store.getWorkflow(run.revision.workflowId)
    const current = this.currentStep(run)
    const role =
      run.coordinatorSessionId === sessionId
        ? 'coordinator'
        : run.steps.some((step) => step.assignedSessionId === sessionId)
          ? 'assigned worker'
          : 'issue participant'
    const stepText = current
      ? [
          `Current step: ${current.title} [${current.status}]`,
          current.instructions,
          current.completionGuidance ? `Completion: ${current.completionGuidance}` : '',
          current.executionProfileSnapshot
            ? `Execution profile: ${current.executionProfileSnapshot.name} (${current.executionProfileSnapshot.harness}/${current.executionProfileSnapshot.model}/${current.executionProfileSnapshot.effort})`
            : current.executionProfileId
              ? `Execution profile unavailable: ${current.executionProfileId}`
              : '',
        ]
          .filter(Boolean)
          .join('\n')
      : run.status === 'complete'
        ? 'Workflow complete.'
        : 'This prompt-only workflow has no structured steps.'
    const delegation =
      role === 'coordinator' && run.subjectKind === 'issue' && current?.executionProfileId
        ? [
            `Delegate this step with: podium agent spawn --issue ${run.subjectId} --prompt "<task>" --workflow-run-id ${run.id} --workflow-step-id ${current.stepId} --execution-profile-id ${current.executionProfileId}`,
            `Then assign the returned child: podium workflow assign-step ${current.stepId} <child-session-id> --run ${run.id}`,
          ].join('\n')
        : ''
    return [
      `# Workflow ${workflow?.name ?? run.revision.workflowId} · revision ${run.revision.version}`,
      `Run: ${run.id} · role: ${role} · status: ${run.status}`,
      run.revision.instructions,
      stepText,
      delegation,
      'Checkpointing is advisory for behavioral/Git rules; Podium records actual session/worktree evidence and returns the next step.',
    ]
      .filter(Boolean)
      .join('\n\n')
  }
}
