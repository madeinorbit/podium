import { randomUUID } from 'node:crypto'
import {
  AgentKind,
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
import type { WorkflowActor, WorkflowRunRow, WorkflowsRepository } from '../../store/workflows'

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

export const workflowInputs = {
  list: z.object({
    includeArchived: z.boolean().optional(),
    scope: WorkflowScope.optional(),
    scopeRef: z.string().optional(),
  }),
  get: z.object({ id: z.string().min(1) }),
  create: scopeInput.extend({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2_000).default(''),
    instructions: z.string().default(''),
    steps: workflowSteps.default([]),
  }),
  revise: revisionBody.extend({ workflowId: z.string().min(1) }),
  fork: scopeInput.extend({
    revisionId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2_000).default(''),
  }),
  publish: z.object({ revisionId: z.string().min(1) }),
  bindings: actorInput,
  assign: z.object({
    targetKind: WorkflowBindingTarget,
    targetId: z.string(),
    revisionId: z.string().min(1),
  }),
  profiles: actorInput,
  profileSave: z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(120),
    accountId: z.string().min(1),
    machineId: z.string().min(1).nullable().optional(),
    harness: AgentKind,
    model: z.string().default('auto'),
    effort: z.string().default('auto'),
  }),
  runs: z.object({ includeTerminal: z.boolean().optional() }),
  prime: actorInput,
  status: z.object({ runId: z.string().optional() }),
  checkpoint: z.object({
    runId: z.string().optional(),
    stepId: z.string().optional(),
    status: z.enum(['active', 'blocked', 'complete']),
    summary: z.string().max(16_000).default(''),
    evidence: WorkflowStepEvidence.default({}),
    observation: WorkflowGitObservation.nullable().optional(),
  }),
  assignStep: z.object({
    runId: z.string().optional(),
    stepId: z.string().min(1),
    sessionId: z.string().nullable(),
  }),
  skip: z.object({
    runId: z.string().optional(),
    stepId: z.string().min(1),
    reason: z.string().default(''),
  }),
  retry: z.object({ runId: z.string().optional(), stepId: z.string().min(1) }),
  adopt: z.object({
    revisionId: z.string().min(1),
    runId: z.string().optional(),
    startStepId: z.string().optional(),
  }),
} as const

export interface WorkflowCaller {
  actor: WorkflowActor
  capability?: Capability
  overrideScope?: boolean
  /** Operator calls and approved server-side operations may change protected
   * global/repository defaults and publish global revisions. */
  protectedWrite?: boolean
}

interface SessionInfo {
  sessionId: string
  cwd: string
  issueId?: string
  agentKind: string
  machineId?: string
}

interface IssueInfo {
  id: string
  repoId?: string
  repoPath: string
  worktreePath: string | null
}

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

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  private actor(caller: WorkflowCaller): WorkflowActor {
    return caller.actor
  }

  private sessionFor(caller: WorkflowCaller): SessionInfo | undefined {
    return caller.actor.kind === 'session' && caller.actor.id
      ? this.deps.session(caller.actor.id)
      : undefined
  }

  private scopeRef(
    scope: z.infer<typeof WorkflowScope>,
    raw: string | null | undefined,
  ): string | null {
    if (scope === 'global') return null
    if (!raw) throw new Error(`${scope} workflows require scopeRef`)
    return raw
  }

  private assertIssueScope(caller: WorkflowCaller, issueId: string): void {
    if (caller.actor.kind === 'operator' || caller.overrideScope) return
    const scope = caller.capability?.scope
    if (scope?.kind === 'subtree' && scope.rootId === issueId) return
    throw new Error(`issue ${issueId} is outside this agent's workflow scope`)
  }

  private assertWorkflowWrite(caller: WorkflowCaller, workflowId: string): void {
    if (caller.actor.kind === 'operator' || caller.overrideScope) return
    const workflow = this.deps.store.getWorkflow(workflowId)
    if (!workflow) throw new Error(`unknown workflow: ${workflowId}`)
    if (workflow.scope === 'global') return // creating candidate revisions is direct
    const session = this.sessionFor(caller)
    if (!session) throw new Error('workflow write lost its session context')
    if (workflow.scope === 'task') {
      if (workflow.scopeRef === session.sessionId || workflow.scopeRef === session.issueId) return
      throw new Error('task workflow is outside this session')
    }
    const repoId = this.deps.repoIdForPath(session.cwd)
    if (repoId && workflow.scopeRef === repoId) return
    throw new Error('repository workflow is outside this session')
  }

  private assertCreateScope(
    caller: WorkflowCaller,
    scope: z.infer<typeof WorkflowScope>,
    scopeRef: string | null,
  ): void {
    if (caller.actor.kind === 'operator' || caller.overrideScope || scope === 'global') return
    const session = this.sessionFor(caller)
    if (!session) throw new Error('workflow creation lost its session context')
    if (scope === 'task' && (scopeRef === session.sessionId || scopeRef === session.issueId)) return
    if (scope === 'repository' && scopeRef === this.deps.repoIdForPath(session.cwd)) return
    throw new Error(`${scope} workflow is outside this session`)
  }
  private canReadWorkflow(caller: WorkflowCaller, workflow: WorkflowWire): boolean {
    if (caller.actor.kind === 'operator' || caller.overrideScope) return true
    if (workflow.scope === 'global') return true
    const session = this.sessionFor(caller)
    if (!session) return false
    if (workflow.scope === 'repository') {
      return workflow.scopeRef === this.deps.repoIdForPath(session.cwd)
    }
    const scope = caller.capability?.scope
    return (
      workflow.scopeRef === session.sessionId ||
      workflow.scopeRef === session.issueId ||
      (scope?.kind === 'subtree' && workflow.scopeRef === scope.rootId)
    )
  }

  private assertWorkflowRead(caller: WorkflowCaller, workflowId: string): void {
    const workflow = this.deps.store.getWorkflow(workflowId)
    if (!workflow) throw new Error(`unknown workflow: ${workflowId}`)
    if (!this.canReadWorkflow(caller, workflow)) {
      throw new Error('workflow is outside this session')
    }
  }

  list(input: z.infer<(typeof workflowInputs)['list']>, caller: WorkflowCaller) {
    return this.deps.store
      .listWorkflows(input)
      .filter((workflow) => this.canReadWorkflow(caller, workflow))
  }

  get(input: z.infer<(typeof workflowInputs)['get']>, caller: WorkflowCaller) {
    const workflow = this.deps.store.getWorkflow(input.id)
    if (!workflow) throw new Error(`unknown workflow: ${input.id}`)
    if (!this.canReadWorkflow(caller, workflow)) {
      throw new Error('workflow is outside this session')
    }
    return { workflow, revisions: this.deps.store.listRevisions(input.id) }
  }

  create(input: z.infer<(typeof workflowInputs)['create']>, caller: WorkflowCaller) {
    const scopeRef = this.scopeRef(input.scope, input.scopeRef)
    this.assertCreateScope(caller, input.scope, scopeRef)
    const now = this.deps.now()
    const workflowId = `wf_${randomUUID()}`
    this.deps.store.insertWorkflow({
      id: workflowId,
      name: input.name,
      description: input.description,
      scope: input.scope,
      scopeRef,
      actor: this.actor(caller),
      now,
    })
    const revision = this.deps.store.insertRevision({
      id: `wfr_${randomUUID()}`,
      workflowId,
      instructions: input.instructions,
      steps: input.steps,
      actor: this.actor(caller),
      now,
    })
    this.deps.store.appendEvent({
      workflowId,
      kind: 'workflow.created',
      actor: this.actor(caller),
      payload: { revisionId: revision.id, scope: input.scope, scopeRef },
      now,
    })
    const workflow = this.deps.store.getWorkflow(workflowId)
    if (!workflow) throw new Error(`workflow creation lost ${workflowId}`)
    return { workflow, revision }
  }

  revise(input: z.infer<(typeof workflowInputs)['revise']>, caller: WorkflowCaller) {
    this.assertWorkflowWrite(caller, input.workflowId)
    const now = this.deps.now()
    const revision = this.deps.store.insertRevision({
      id: `wfr_${randomUUID()}`,
      workflowId: input.workflowId,
      instructions: input.instructions,
      steps: input.steps,
      actor: this.actor(caller),
      now,
    })
    this.deps.store.appendEvent({
      workflowId: input.workflowId,
      kind: 'workflow.revised',
      actor: this.actor(caller),
      payload: { revisionId: revision.id, version: revision.version },
      now,
    })
    return revision
  }

  fork(input: z.infer<(typeof workflowInputs)['fork']>, caller: WorkflowCaller) {
    const source = this.deps.store.getRevision(input.revisionId)
    if (!source) throw new Error(`unknown workflow revision: ${input.revisionId}`)
    this.assertWorkflowRead(caller, source.workflowId)
    return this.create(
      {
        name: input.name,
        description: input.description,
        scope: input.scope,
        scopeRef: input.scopeRef,
        instructions: source.instructions,
        steps: source.steps,
      },
      caller,
    )
  }

  publish(input: z.infer<(typeof workflowInputs)['publish']>, caller: WorkflowCaller) {
    const revision = this.deps.store.getRevision(input.revisionId)
    if (!revision) throw new Error(`unknown workflow revision: ${input.revisionId}`)
    const workflow = this.deps.store.getWorkflow(revision.workflowId)
    if (!workflow) throw new Error(`workflow revision ${revision.id} lost its workflow`)
    this.assertWorkflowWrite(caller, workflow.id)
    if (workflow.scope === 'global' && caller.actor.kind === 'session' && !caller.protectedWrite) {
      throw new Error('approval required to publish a global workflow revision')
    }
    const now = this.deps.now()
    this.deps.store.publishRevision(revision.id, now)
    this.deps.store.appendEvent({
      workflowId: workflow.id,
      kind: 'workflow.published',
      actor: this.actor(caller),
      payload: { revisionId: revision.id },
      now,
    })
    const published = this.deps.store.getRevision(revision.id)
    if (!published) throw new Error(`published workflow revision ${revision.id} disappeared`)
    return published
  }

  bindings(_input: z.infer<(typeof workflowInputs)['bindings']>, caller: WorkflowCaller) {
    if (caller.actor.kind === 'operator' || caller.overrideScope) {
      return this.deps.store.listBindings()
    }
    const session = this.sessionFor(caller)
    const repoId = session ? this.deps.repoIdForPath(session.cwd) : null
    const scope = caller.capability?.scope
    return this.deps.store.listBindings().filter((binding) => {
      if (binding.targetKind === 'global') return true
      if (binding.targetKind === 'repository') return binding.targetId === repoId
      if (binding.targetKind === 'session') return binding.targetId === caller.actor.id
      return (
        binding.targetId === session?.issueId ||
        (scope?.kind === 'subtree' && binding.targetId === scope.rootId)
      )
    })
  }

  assign(input: z.infer<(typeof workflowInputs)['assign']>, caller: WorkflowCaller) {
    const revision = this.deps.store.getRevision(input.revisionId)
    if (!revision) throw new Error(`unknown workflow revision: ${input.revisionId}`)
    this.assertWorkflowRead(caller, revision.workflowId)
    if (
      (input.targetKind === 'global' || input.targetKind === 'repository') &&
      caller.actor.kind === 'session' &&
      !caller.protectedWrite
    ) {
      throw new Error(`approval required to change the ${input.targetKind} workflow default`)
    }
    if (
      (input.targetKind === 'global' || input.targetKind === 'repository') &&
      revision.publishedAt === null
    ) {
      throw new Error('shared workflow defaults require a published revision')
    }
    if (input.targetKind === 'issue') this.assertIssueScope(caller, input.targetId)
    if (
      input.targetKind === 'session' &&
      caller.actor.kind === 'session' &&
      caller.actor.id !== input.targetId &&
      !caller.overrideScope
    ) {
      throw new Error('agents may directly assign only their own session')
    }
    const now = this.deps.now()
    const binding = this.deps.store.setBinding({ ...input, actor: this.actor(caller), now })
    this.deps.store.appendEvent({
      workflowId: revision.workflowId,
      kind: 'workflow.assigned',
      actor: this.actor(caller),
      payload: input,
      now,
    })
    return binding
  }

  profiles(_input: z.infer<(typeof workflowInputs)['profiles']>, _caller: WorkflowCaller) {
    return this.deps.store.listProfiles()
  }

  profileSave(input: z.infer<(typeof workflowInputs)['profileSave']>, caller: WorkflowCaller) {
    if (caller.actor.kind === 'session' && !caller.protectedWrite) {
      throw new Error('only the operator may change execution profiles')
    }
    const now = this.deps.now()
    return this.deps.store.upsertProfile({
      id: input.id ?? `wfp_${randomUUID()}`,
      name: input.name,
      accountId: input.accountId,
      machineId: input.machineId ?? null,
      harness: input.harness,
      model: input.model,
      effort: input.effort,
      actor: this.actor(caller),
      now,
    })
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
    const harness = AgentKind.safeParse(profile.harness)
    if (!harness.success) {
      throw new Error(`execution profile ${profile.id} has unsupported harness ${profile.harness}`)
    }
    return { ...profile, harness: harness.data }
  }

  private liveRunForSession(sessionId: string): WorkflowRunRow | null {
    const direct = this.deps.store.findLiveRunForSession(sessionId)
    if (direct) return direct
    const issueId = this.deps.session(sessionId)?.issueId
    return issueId ? this.deps.store.findLiveRun('issue', issueId) : null
  }

  runs(input: z.infer<(typeof workflowInputs)['runs']>, caller: WorkflowCaller) {
    if (caller.actor.kind === 'operator') {
      return this.deps.store.listRuns(input.includeTerminal ?? false).map((run) => this.toRun(run))
    }
    if (!caller.actor.id) return []
    const run = this.liveRunForSession(caller.actor.id)
    return run ? [this.toRun(run)] : []
  }

  private assertRevisionMatchesStart(
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

  private toRun(row: WorkflowRunRow): WorkflowRunWire {
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

  private runFor(caller: WorkflowCaller, requested?: string): WorkflowRunWire {
    const row = requested
      ? this.deps.store.getRun(requested)
      : caller.actor.id
        ? this.liveRunForSession(caller.actor.id)
        : null
    if (!row) throw new Error('no active workflow run for this session')
    const run = this.toRun(row)
    if (caller.actor.kind === 'operator') return run
    const sessionId = caller.actor.id
    if (
      sessionId === run.coordinatorSessionId ||
      run.steps.some((step) => step.assignedSessionId === sessionId) ||
      (sessionId !== null &&
        run.subjectKind === 'issue' &&
        this.deps.session(sessionId)?.issueId === run.subjectId)
    )
      return run
    throw new Error('workflow run is outside this session')
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

  private currentStep(run: WorkflowRunWire): WorkflowRunStepWire | null {
    return (
      run.steps.find((step) => step.status === 'active' || step.status === 'blocked') ??
      run.steps.find((step) => step.status === 'pending') ??
      null
    )
  }

  private nextPacket(
    runId: string,
    message: string,
    warnings: string[] = [],
  ): WorkflowNextActionWire {
    const row = this.deps.store.getRun(runId)
    if (!row) throw new Error(`workflow run ${runId} disappeared`)
    const run = this.toRun(row)
    const current = this.currentStep(run)
    return { run, currentStep: current, nextStep: current, message, warnings }
  }

  private assertCoordinator(run: WorkflowRunWire, caller: WorkflowCaller): void {
    if (caller.actor.kind === 'operator' || caller.actor.id === run.coordinatorSessionId) return
    throw new Error('only the workflow coordinator may perform this transition')
  }

  checkpoint(
    input: z.infer<(typeof workflowInputs)['checkpoint']>,
    caller: WorkflowCaller,
  ): WorkflowNextActionWire {
    const run = this.runFor(caller, input.runId)
    const now = this.deps.now()
    if (run.steps.length === 0) {
      this.assertCoordinator(run, caller)
      if (input.status === 'complete') this.deps.store.updateRunStatus(run.id, 'complete', now)
      else
        this.deps.store.updateRunStatus(
          run.id,
          input.status === 'blocked' ? 'blocked' : 'active',
          null,
        )
      this.deps.store.appendEvent({
        workflowId: run.revision.workflowId,
        runId: run.id,
        kind: `workflow.run_${input.status}`,
        actor: this.actor(caller),
        payload: { summary: input.summary, evidence: input.evidence },
        now,
      })
      return this.nextPacket(
        run.id,
        input.status === 'complete' ? 'Workflow complete.' : `Workflow ${input.status}.`,
      )
    }
    const current = this.currentStep(run)
    if (!current) throw new Error('workflow has no remaining step')
    const step = input.stepId
      ? run.steps.find((candidate) => candidate.stepId === input.stepId)
      : current
    if (!step) throw new Error(`workflow has no step ${input.stepId}`)
    if (step.stepId !== current.stepId)
      throw new Error(`step ${step.stepId} is not the current linear step`)
    const sessionId = caller.actor.id
    const allowed =
      caller.actor.kind === 'operator' ||
      sessionId === run.coordinatorSessionId ||
      (step.assignedSessionId !== null && sessionId === step.assignedSessionId)
    if (!allowed) throw new Error('session is not assigned to this workflow step')
    const observation = input.observation ?? null
    const warnings = this.observationWarningsForRun(run, step, caller, input.status, observation)
    const assignedSessionId =
      step.assignedSessionId ?? (caller.actor.kind === 'session' ? caller.actor.id : null)
    this.deps.store.updateStep({
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
    const updatedSteps = this.deps.store.getRunSteps(run.id)
    const remaining = updatedSteps.find((candidate) => candidate.status === 'pending')
    if (input.status === 'blocked') this.deps.store.updateRunStatus(run.id, 'blocked', null)
    else if (input.status === 'complete' && !remaining)
      this.deps.store.updateRunStatus(run.id, 'complete', now)
    else this.deps.store.updateRunStatus(run.id, 'active', null)
    this.deps.store.appendEvent({
      workflowId: run.revision.workflowId,
      runId: run.id,
      kind: `workflow.step_${input.status}`,
      actor: this.actor(caller),
      payload: { stepId: step.stepId, summary: input.summary, warnings },
      now,
    })
    const worker = caller.actor.id && caller.actor.id !== run.coordinatorSessionId
    if (worker && this.deps.notifyCoordinator) {
      this.deps.notifyCoordinator(
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
    return this.nextPacket(run.id, message, warnings)
  }

  private observationWarningsForRun(
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

  assignStep(input: z.infer<(typeof workflowInputs)['assignStep']>, caller: WorkflowCaller) {
    const run = this.runFor(caller, input.runId)
    this.assertCoordinator(run, caller)
    const current = this.currentStep(run)
    if (!current || current.stepId !== input.stepId)
      throw new Error('only the current step may be assigned')
    this.deps.store.assignStep(run.id, input.stepId, input.sessionId)
    this.deps.store.appendEvent({
      workflowId: run.revision.workflowId,
      runId: run.id,
      kind: 'workflow.step_assigned',
      actor: this.actor(caller),
      payload: { stepId: input.stepId, sessionId: input.sessionId },
      now: this.deps.now(),
    })
    return this.nextPacket(
      run.id,
      input.sessionId ? `Step assigned to ${input.sessionId}.` : 'Step unassigned.',
    )
  }

  skip(input: z.infer<(typeof workflowInputs)['skip']>, caller: WorkflowCaller) {
    const run = this.runFor(caller, input.runId)
    this.assertCoordinator(run, caller)
    const current = this.currentStep(run)
    if (!current || current.stepId !== input.stepId)
      throw new Error('only the current step may be skipped')
    const now = this.deps.now()
    this.deps.store.updateStep({
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
    const remaining = this.deps.store.getRunSteps(run.id).find((step) => step.status === 'pending')
    if (!remaining) this.deps.store.updateRunStatus(run.id, 'complete', now)
    else this.deps.store.updateRunStatus(run.id, 'active', null)
    this.deps.store.appendEvent({
      workflowId: run.revision.workflowId,
      runId: run.id,
      kind: 'workflow.step_skipped',
      actor: this.actor(caller),
      payload: { stepId: current.stepId, reason: input.reason },
      now,
    })
    return this.nextPacket(
      run.id,
      remaining ? `Skipped. Next: ${remaining.title}` : 'Workflow complete.',
    )
  }

  retry(input: z.infer<(typeof workflowInputs)['retry']>, caller: WorkflowCaller) {
    const run = this.runFor(caller, input.runId)
    this.assertCoordinator(run, caller)
    const target = run.steps.find((step) => step.stepId === input.stepId)
    if (!target) throw new Error(`workflow has no step ${input.stepId}`)
    const laterStarted = run.steps.some(
      (step) => step.position > target.position && step.status !== 'pending',
    )
    if (laterStarted) throw new Error('cannot retry a step after a later step has started')
    this.deps.store.resetStep(run.id, target.stepId)
    this.deps.store.updateRunStatus(run.id, 'active', null)
    this.deps.store.appendEvent({
      workflowId: run.revision.workflowId,
      runId: run.id,
      kind: 'workflow.step_retried',
      actor: this.actor(caller),
      payload: { stepId: target.stepId },
      now: this.deps.now(),
    })
    return this.nextPacket(run.id, `Retry ready: ${target.title}`)
  }

  adopt(input: z.infer<(typeof workflowInputs)['adopt']>, caller: WorkflowCaller) {
    const current = this.runFor(caller, input.runId)
    this.assertCoordinator(current, caller)
    if (current.status !== 'active' && current.status !== 'blocked')
      throw new Error('only an active workflow run may adopt a revision')
    const coordinatorSessionId = caller.actor.id ?? current.coordinatorSessionId
    const session = this.deps.session(coordinatorSessionId)
    if (!session) throw new Error('coordinator session no longer exists')
    const revision = this.deps.store.getRevision(input.revisionId)
    if (!revision) throw new Error(`unknown workflow revision: ${input.revisionId}`)
    this.assertWorkflowRead(caller, revision.workflowId)
    const issueId = current.subjectKind === 'issue' ? current.subjectId : undefined
    this.assertRevisionMatchesStart(revision, {
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...(issueId ? { issueId } : {}),
    })
    if (input.startStepId && !revision.steps.some((step) => step.id === input.startStepId))
      throw new Error(`workflow has no step ${input.startStepId}`)
    const now = this.deps.now()
    this.deps.store.updateRunStatus(current.id, 'superseded', now)
    return this.startRun({
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...(issueId ? { issueId } : {}),
      revisionId: input.revisionId,
      supersedesRunId: current.id,
      startStepId: input.startStepId,
    })
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
