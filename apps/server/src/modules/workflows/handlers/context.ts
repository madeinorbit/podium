/**
 * The L3 handler context for the eleven workflow contracts (POD-731).
 *
 * ADR 3 D1's split: the CONTRACT is L1 data in `@podium/commands`; the HANDLER
 * is here, with the feature, where it may reach the store and the session
 * index. This module holds what all eleven handlers share — {@link
 * WorkflowAccess}, which is now the ONLY place workflow authorization is
 * decided.
 *
 * ---------------------------------------------------------------------------
 * SIXTEEN GUARDS, ONE DECISION
 * ---------------------------------------------------------------------------
 *
 * POD-730 enumerated sixteen authorization sites in `service.ts` by a byte-wise
 * scan. Eleven of them shared one shape — `if (caller.actor.kind === 'operator')
 * return` — and three of those eleven sat in QUERIES (`bindings`, `runs`,
 * `runFor`), which is what made them easy to miss and what makes them
 * cross-user READS the moment there is a second human. `profileSave` was the
 * inverse shape, refusing a session without `protectedWrite`, and `profiles()`
 * had no gate at all.
 *
 * Every one of them is replaced here by `workflowDecision` against a real
 * principal. The grep that says so — `actor.kind === 'operator'` — returns
 * nothing on the new path, and the reason it returns nothing is that role class
 * is no longer sufficient on its own to answer any question on this surface.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSPORT EDGE IS THE COMPLIANCE QUESTION
 * ---------------------------------------------------------------------------
 *
 * POD-730's reviewer note is exact: "if `workflowCaller()` still mints an
 * unconstrained capability, the guards below cannot have been fixed no matter
 * what they now say." {@link workflowPrincipal} is where that is answered — it
 * derives an ADR 9 D1 `(actor, on-behalf-of, role)` principal from the
 * authenticated transport, and it does NOT hand out `admin` for the mere
 * absence of a session id. "Operator" as a synonym for "not an agent" does not
 * survive this function.
 */

import {
  canReadWorkflowEntity,
  type PlacementDecision,
  placementDecision,
  SINGLE_USER_HUMAN,
  SINGLE_USER_WORKFLOW_OWNERSHIP,
  type WorkflowEntityRef,
  type WorkflowOwnershipPort,
  type WorkflowPrincipal,
  type WorkflowVerb,
  workflowDecision,
} from '@podium/commands'
import type {
  WorkflowBindingWire,
  WorkflowRunStepWire,
  WorkflowRunWire,
  WorkflowWire,
} from '@podium/protocol'
import type { WorkflowRunRow } from '../../../store/workflows'
import type { WorkflowCaller, WorkflowEngine, WorkflowServiceDeps } from '../service'

// ---------------------------------------------------------------------------
// The consistent-error rule, as constants (ADR 3 Amendment 1 D20.2)
// ---------------------------------------------------------------------------

/**
 * THE messages. Invisible and nonexistent produce the SAME string, from the
 * SAME site, so the convergence is a property of there being one constant
 * rather than of two strings being kept in sync by hand.
 *
 * POD-730 §10 pinned five divergent shapes: `unknown workflow: <id>` against
 * `workflow is outside this session`, three different write-side messages by
 * scope, and a revision id that CONFIRMED existence before refusing. Each of
 * those told an enumerating caller which ids are real.
 *
 * The convergence goes toward the UNKNOWN message in every case, never toward
 * the out-of-scope one. That direction is the whole point: the unknown message
 * names only the id the caller already supplied and confirms nothing, while
 * "outside this session" confirms the row exists. Converging the other way
 * would have produced two identical strings that both leak.
 */
export const unknownWorkflow = (id: string): string => `unknown workflow: ${id}`
export const unknownRevision = (id: string): string => `unknown workflow revision: ${id}`

/**
 * The run message, which deliberately does NOT name the id back.
 *
 * It is the message the shipped code already produced for an unknown run — the
 * one path POD-730 found that never echoed the caller's id — so converging the
 * INVISIBLE case onto it both satisfies D20.2 and lands on the strictest of the
 * five shapes rather than inventing a sixth.
 */
export const NO_RUN = 'no active workflow run for this session'

/**
 * Machine placement, which is the ONE carve-out and pulls the opposite way
 * (readiness §3.1.4 M5). `use` is a code-execution boundary, so "denied" and
 * "offline" must stay distinguishable — otherwise both produce the same empty
 * result and an operator cannot tell a permissions problem from a dead machine.
 * D20.2 and M5 disagree on purpose and are decided separately.
 */
export const machineUnauthorized = (machineId: string): string =>
  `not authorized to run work on machine ${machineId}`
export const machineUnreachable = (machineId: string): string =>
  `machine ${machineId} is unreachable`

// ---------------------------------------------------------------------------
// The ports
// ---------------------------------------------------------------------------

/**
 * Whether the effective principal may `use` a machine, and whether it is
 * reachable — readiness §3.1.4 M1/M5/M6.
 *
 * Structurally identical to the mail vertical's port ON PURPOSE. Two shapes for
 * "may this principal run code there" is how a second fleet ACL gets built, and
 * M6 is explicit that agents inherit machine grants through the A1/A2
 * intersection — so this is one check against the effective principal, not a
 * separate list.
 */
export interface WorkflowMachineAccess {
  mayUse(machineId: string): boolean
  isReachable(machineId: string): boolean
}

/**
 * Machine access as it stands until POD-1079 lands machine ownership.
 *
 * EXPIRES WHEN: POD-1079 lands. The composition root then resolves this against
 * the effective principal and this constant is DELETED, not reconfigured — a
 * code-execution boundary that can be widened by configuration is one that can
 * be widened by accident (readiness §3.1.4 M2).
 */
export const SINGLE_USER_MACHINE_ACCESS: WorkflowMachineAccess = {
  mayUse: () => true,
  isReachable: () => true,
}

/** The three ports a composition root supplies. Absent = the honest
 *  single-user present; never a disabled check. */
export interface WorkflowPolicyPorts {
  ownership?: WorkflowOwnershipPort
  machines?: WorkflowMachineAccess
}

// ---------------------------------------------------------------------------
// The principal — where ADR 9 D1.5 is actually answered
// ---------------------------------------------------------------------------

/**
 * Derive the ADR 9 D1 principal from a caller.
 *
 * WHAT CHANGED, in one sentence: `protectedWrite` no longer means "may do
 * anything", it means the account grade is `admin`, and the grade decides only
 * the admin-grade paths (the global library, execution profiles) rather than
 * short-circuiting every guard.
 *
 * WHAT DID NOT CHANGE, deliberately: `protectedWrite` is still the flag the
 * transport sets, and the single human is still `SINGLE_USER_HUMAN`. This
 * function is the seam where POD-1075's real `(user, device, capability)`
 * principal replaces both — at which point `onBehalfOf` comes from the
 * delegation record and `role` from the account, and nothing downstream of here
 * changes at all. That is the point of putting the derivation in one function.
 *
 * `onBehalfOf` is resolved on EVERY call and never memoized. ADR 9 D5 A1: an
 * agent's rights are its human's CURRENT rights, so a revoked delegation must
 * be able to answer `null` at the next apply of a run that started an hour ago.
 */
export function workflowPrincipal(caller: WorkflowCaller): WorkflowPrincipal {
  return {
    actor: caller.actor.id ?? 'operator',
    onBehalfOf: caller.onBehalfOf === undefined ? SINGLE_USER_HUMAN : caller.onBehalfOf,
    role: caller.protectedWrite === true ? 'admin' : 'member',
  }
}

// ---------------------------------------------------------------------------
// The handler context
// ---------------------------------------------------------------------------

export interface WorkflowHandlerContext {
  caller: WorkflowCaller
  deps: WorkflowServiceDeps
  access: WorkflowAccess
  /**
   * The run/state arithmetic the handlers share — `WorkflowService` itself,
   * narrowed to what a handler may reach.
   *
   * INTERIM, and named as such: the state machine still lives on the service
   * while POD-732 does the cutover and the deletion. What moved in THIS issue
   * is authorization, which is the part that was wrong; moving the state
   * machine at the same time would have made the diff unreviewable against
   * POD-730's oracle, which is the one thing that must not happen.
   */
  engine: WorkflowEngine
}

// ---------------------------------------------------------------------------
// WorkflowAccess — the one authz path
// ---------------------------------------------------------------------------

export class WorkflowAccess {
  private readonly ownership: WorkflowOwnershipPort
  readonly machines: WorkflowMachineAccess

  constructor(
    private readonly deps: WorkflowServiceDeps,
    ports?: WorkflowPolicyPorts,
  ) {
    this.ownership = ports?.ownership ?? SINGLE_USER_WORKFLOW_OWNERSHIP
    this.machines = ports?.machines ?? SINGLE_USER_MACHINE_ACCESS
  }

  principal(caller: WorkflowCaller): WorkflowPrincipal {
    return workflowPrincipal(caller)
  }

  /**
   * Which CLASS a workflow row belongs to — and the one place scope becomes a
   * visibility class.
   *
   * A global-scope definition is a `workflow-library-entry`, whose WRITE is
   * admin-grade. The shipped code reached the same fork with `if (workflow.scope
   * === 'global') return` in THREE separate guards, each returning early and so
   * each opening the write path; here the scope maps to a class once and the
   * decision is taken by one function.
   */
  private entityFor(workflow: Pick<WorkflowWire, 'id' | 'scope'>): WorkflowEntityRef {
    return workflow.scope === 'global'
      ? { kind: 'workflow-library-entry', id: workflow.id }
      : { kind: 'workflow-definition', id: workflow.id }
  }

  private decide(
    caller: WorkflowCaller,
    entity: WorkflowEntityRef,
    verb: WorkflowVerb,
  ): 'allowed' | 'denied' {
    return workflowDecision(this.principal(caller), entity, verb, this.ownership)
  }

  /**
   * Does this caller have an AGENT SCOPE to be bounded by?
   *
   * READ THIS BEFORE CONCLUDING THE OPERATOR ARM CAME BACK. It did not, and the
   * difference is the whole of readiness §3.1.3 A2.
   *
   * The deleted arm was `if (caller.actor.kind === 'operator') return` at the
   * TOP of a guard, which skipped the OWNERSHIP decision as well as the scope
   * one — that is what made every authenticated person an admin over every
   * workflow. Ownership is now decided separately, first, and for every
   * principal without exception.
   *
   * What remains is narrower and is a different question. A2 says an agent's
   * default reach is what it was SPAWNED FOR, not everything its human can see:
   * the scope arm exists to hold an agent inside its subtree. A principal that
   * is not acting through a session has no subtree — there is no spawn to have
   * been scoped by — so there is nothing for this arm to check, and inventing a
   * bound for it would not be conservative, it would be arbitrary. Its bound is
   * ownership, which has already been applied.
   *
   * The test that tells the two apart: a MEMBER human is `false` here too, and
   * is still refused on another person's workflow — by the ownership decision.
   * The old arm would have let them through.
   */
  private hasAgentScope(caller: WorkflowCaller): boolean {
    return caller.actor.kind === 'session' && caller.actor.id !== null
  }

  private sessionFor(caller: WorkflowCaller) {
    return caller.actor.kind === 'session' && caller.actor.id
      ? this.deps.session(caller.actor.id)
      : undefined
  }

  /**
   * THE SCOPE ARM, kept.
   *
   * Ownership answers "whose row is this"; scope answers "is this agent working
   * on it". Both are required and neither subsumes the other — readiness
   * §3.1.3 A2: an agent's default reach is what it was SPAWNED FOR, not
   * everything its human can see, and widening stays the explicit
   * `overrideScope` path. Dropping this when ownership arrived would have
   * silently widened every agent to its human's whole surface, which is A2
   * inverted.
   *
   * What is gone from it is the operator early return.
   */
  private inScope(caller: WorkflowCaller, workflow: WorkflowWire): boolean {
    if (!this.hasAgentScope(caller) || caller.overrideScope) return true
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

  /** The WRITE arm of the scope check. Narrower than {@link inScope} for task
   *  workflows — it does not accept the capability's subtree root — which
   *  POD-730 §3 pinned as an ARTEFACT of the two arms being written twice. It
   *  stays narrower here: a read that is wider than a write is the safe
   *  direction, and converging them belongs to whoever can re-derive both from
   *  one rule rather than to a migration. */
  private inWriteScope(caller: WorkflowCaller, workflow: WorkflowWire): boolean {
    if (!this.hasAgentScope(caller) || caller.overrideScope) return true
    const session = this.sessionFor(caller)
    if (!session) return false
    if (workflow.scope === 'global') return true
    if (workflow.scope === 'task') {
      return workflow.scopeRef === session.sessionId || workflow.scopeRef === session.issueId
    }
    const repoId = this.deps.repoIdForPath(session.cwd)
    return repoId !== null && workflow.scopeRef === repoId
  }

  canReadWorkflow(caller: WorkflowCaller, workflow: WorkflowWire): boolean {
    if (!canReadWorkflowEntity(this.principal(caller), this.entityFor(workflow), this.ownership)) {
      return false
    }
    return this.inScope(caller, workflow)
  }

  /**
   * Read a workflow by id, or fail EXACTLY as an unknown id fails.
   *
   * One `throw`, one message, for both outcomes — which is what makes D20.2 a
   * property of the code shape rather than of two strings agreeing.
   */
  assertWorkflowRead(caller: WorkflowCaller, workflowId: string): WorkflowWire {
    const workflow = this.deps.store.getWorkflow(workflowId)
    if (!workflow || !this.canReadWorkflow(caller, workflow)) {
      throw new Error(unknownWorkflow(workflowId))
    }
    return workflow
  }

  /** The write decision, converged onto the same message for the same reason. */
  assertWorkflowWrite(caller: WorkflowCaller, workflowId: string): WorkflowWire {
    const workflow = this.deps.store.getWorkflow(workflowId)
    if (!workflow) throw new Error(unknownWorkflow(workflowId))
    const entity = this.entityFor(workflow)
    if (this.decide(caller, entity, 'write') === 'denied') {
      // A global library entry is the one case whose refusal is about GRADE and
      // not about visibility, and the caller can already see the row — so it
      // says so, rather than pretending the row does not exist. That is not a
      // D20.2 exception: nothing is disclosed that a read did not already give.
      if (entity.kind === 'workflow-library-entry') {
        throw new Error('approval required to change a global workflow')
      }
      throw new Error(unknownWorkflow(workflowId))
    }
    if (!this.inWriteScope(caller, workflow)) throw new Error(unknownWorkflow(workflowId))
    return workflow
  }

  /** Creating into a scope. The `scope === 'global'` early return is gone: a
   *  global create is a library WRITE and is admin-grade. */
  assertCreateScope(
    caller: WorkflowCaller,
    scope: WorkflowWire['scope'],
    scopeRef: string | null,
  ): void {
    if (scope === 'global') {
      if (this.principal(caller).role !== 'admin') {
        throw new Error('approval required to create a global workflow')
      }
      return
    }
    if (!this.hasAgentScope(caller) || caller.overrideScope) return
    const session = this.sessionFor(caller)
    if (!session) throw new Error('workflow creation lost its session context')
    if (scope === 'task' && (scopeRef === session.sessionId || scopeRef === session.issueId)) return
    if (scope === 'repository' && scopeRef === this.deps.repoIdForPath(session.cwd)) return
    throw new Error(`${scope} workflow is outside this session`)
  }

  /** The issue-target arm of `assign`. Unchanged apart from its operator early
   *  return; the issue's own authority is `checkIssueAccess`'s and is not
   *  restated here. */
  assertIssueScope(caller: WorkflowCaller, issueId: string): void {
    if (!this.hasAgentScope(caller) || caller.overrideScope) return
    const scope = caller.capability?.scope
    if (scope?.kind === 'subtree' && scope.rootId === issueId) return
    throw new Error(`issue ${issueId} is outside this agent's workflow scope`)
  }

  /**
   * Whether a caller may see a RUN — replacing `runFor`'s operator arm, which
   * resolved any run by id.
   *
   * The ownership half asks the run's own class; the participation half is the
   * shipped rule (coordinator, assignee, or a session on the run's issue) and
   * is A2 again: being your human's agent does not make every one of their runs
   * your business.
   */
  canSeeRun(caller: WorkflowCaller, run: WorkflowRunWire): boolean {
    if (
      !canReadWorkflowEntity(
        this.principal(caller),
        { kind: 'workflow-run', id: run.id },
        this.ownership,
      )
    ) {
      return false
    }
    const sessionId = caller.actor.id
    if (sessionId === null) return this.principal(caller).role === 'admin'
    return (
      sessionId === run.coordinatorSessionId ||
      run.steps.some((step) => step.assignedSessionId === sessionId) ||
      (run.subjectKind === 'issue' && this.deps.session(sessionId)?.issueId === run.subjectId)
    )
  }

  /** Coordinator-only transitions. The operator arm — "may perform ANY
   *  transition on ANY run" — is gone. */
  assertCoordinator(run: WorkflowRunWire, caller: WorkflowCaller): void {
    if (caller.actor.id !== null && caller.actor.id === run.coordinatorSessionId) return
    if (caller.actor.id === null && this.principal(caller).role === 'admin') return
    throw new Error('only the workflow coordinator may perform this transition')
  }

  /**
   * `checkpoint`'s allowed check. The operator arm accepted ANY step, assigned
   * or not; what remains is the rule that was already doing the work —
   * coordinator, or the step's own assignee.
   */
  mayCheckpoint(run: WorkflowRunWire, step: WorkflowRunStepWire, caller: WorkflowCaller): boolean {
    const sessionId = caller.actor.id
    if (sessionId === null) return this.principal(caller).role === 'admin'
    return (
      sessionId === run.coordinatorSessionId ||
      (step.assignedSessionId !== null && sessionId === step.assignedSessionId)
    )
  }

  /**
   * `bindings()` — the first of the three read-shaped operator branches, which
   * returned EVERY binding in the instance.
   *
   * Now: the participation filter that already existed for sessions, applied to
   * everyone, plus the ownership decision per row. An admin still sees the lot,
   * but through the decision rather than around it.
   */
  visibleBindings(caller: WorkflowCaller, all: readonly WorkflowBindingWire[]) {
    const principal = this.principal(caller)
    const session = this.sessionFor(caller)
    const repoId = session ? this.deps.repoIdForPath(session.cwd) : null
    const scope = caller.capability?.scope
    return all.filter((binding) => {
      if (
        !canReadWorkflowEntity(
          principal,
          { kind: 'workflow-binding', id: `${binding.targetKind}:${binding.targetId}` },
          this.ownership,
        )
      ) {
        return false
      }
      // The PARTICIPATION filter, which is A2's agent-scope arm again and not
      // an ownership question — ownership was decided one line above, for every
      // principal. A caller with no agent scope has no subtree to be held
      // inside, and `overrideScope` is D2's explicit widening within the
      // human's ceiling, which POD-730 pins as behaving like the operator arm
      // on every other read. Neither widens PAST the ownership decision.
      if (!this.hasAgentScope(caller) || caller.overrideScope) return true
      if (binding.targetKind === 'global') return true
      if (binding.targetKind === 'repository') return binding.targetId === repoId
      if (binding.targetKind === 'session') return binding.targetId === caller.actor.id
      return (
        binding.targetId === session?.issueId ||
        (scope?.kind === 'subtree' && binding.targetId === scope.rootId)
      )
    })
  }

  /** `profiles()` — the branch that had NO gate at all and listed every
   *  profile, with its `accountId`, to any caller. */
  visibleProfiles<T extends { id: string }>(caller: WorkflowCaller, all: readonly T[]): T[] {
    const principal = this.principal(caller)
    return all.filter((profile) =>
      canReadWorkflowEntity(
        principal,
        { kind: 'execution-profile', id: profile.id },
        this.ownership,
      ),
    )
  }

  /** `profileSave` — the inverse-shaped guard, now the same decision as every
   *  other write, taken against the account grade ADR 1 D6 requires for
   *  anything that manages managed credentials. */
  assertProfileWrite(caller: WorkflowCaller, profileId: string | undefined): void {
    const principal = this.principal(caller)
    if (principal.role !== 'admin') {
      throw new Error('only an administrator may change execution profiles')
    }
    if (
      profileId !== undefined &&
      workflowDecision(
        principal,
        { kind: 'execution-profile', id: profileId },
        'write',
        this.ownership,
      ) === 'denied'
    ) {
      throw new Error('only an administrator may change execution profiles')
    }
  }

  /** `runs()` — the second read-shaped branch, which returned every run in the
   *  instance for an operator. Filtering is by the SAME decision `runFor` uses,
   *  so a run you cannot open is a run you cannot list. */
  visibleRuns(caller: WorkflowCaller, runs: readonly WorkflowRunWire[]): WorkflowRunWire[] {
    return runs.filter((run) => this.canSeeRun(caller, run))
  }

  /**
   * PLACEMENT — readiness §3.1.4 M5, and the one decision on this surface that
   * keeps unauthorized distinguishable from unreachable.
   *
   * Checked at ASSIGN time and again at APPLY, because a grant can be revoked
   * between the two and a run is long-lived. Never silently retargeted: placing
   * a caller's code on a machine they did not choose is worse than refusing.
   */
  assertMayPlaceOn(machineId: string | null | undefined): void {
    if (!machineId) return
    const decision: PlacementDecision = placementDecision(machineId, this.machines)
    if (decision === 'unauthorized') throw new Error(machineUnauthorized(machineId))
    if (decision === 'unreachable') throw new Error(machineUnreachable(machineId))
  }

  /** The machine a session sits on, for the assign-time placement check. */
  machineForSession(sessionId: string | null): string | undefined {
    return sessionId ? this.deps.session(sessionId)?.machineId : undefined
  }

  /** Exposed for the run helpers on the engine, which resolve rows before the
   *  visibility decision can be taken. */
  toRunVisible(caller: WorkflowCaller, row: WorkflowRunRow | null): WorkflowRunRow {
    if (!row) throw new Error(NO_RUN)
    return row
  }
}
