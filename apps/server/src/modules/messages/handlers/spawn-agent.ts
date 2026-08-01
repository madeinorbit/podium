/**
 * Handler for the `mail.spawnAgent` contract (L3).
 *
 * `podium agent spawn`: a full Podium session on the target issue, via the ONE
 * spawn path (SessionsService.createSession). The caller becomes the child's
 * parent (`spawnedBy 'session:<id>'`) — which is what unlocks the parent-grade
 * clamps (interrupt + wake) the clamp matrix already implements. No issue is
 * EVER auto-created: `newTitle` is the explicit --new path.
 *
 * TWO gates, per the contract: write access to the target issue, and `use` on
 * the machine the resolved execution profile places the child on.
 */

import { type ContractInput, type spawnAgentContract, UNADDRESSABLE } from '@podium/commands'
import { checkIssueAccess } from '../../../issue-authz'
import { attributionOf, onBehalfOfUser } from '../../../command-principal'
import { SPAWN_BUDGET_PER_DAY } from '../service'
import type { MailHandlerContext } from './context'

export function spawnAgentHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof spawnAgentContract>,
): unknown {
  const { caller, deps, access } = ctx
  if (!caller.principal) throw new Error('agent spawn requires an authenticated principal')
  const attribution = attributionOf(caller.principal)
  const callerOwner = onBehalfOfUser(caller.principal)
  if (callerOwner === null) throw new Error('agent spawn requires a human owner')
  if (!deps.spawnSession) throw new Error('agent spawn is not wired on this server')
  const issues = deps.issues()
  if (input.issue && input.newTitle) throw new Error('pass --issue OR --new, not both')
  let issueId: string
  if (input.issue) {
    // Under the human ceiling, exactly as on the send path: an issue beyond the
    // delegating human's visibility must fail as an unknown issue, so it takes
    // the `unknown issue` branch below rather than a distinguishable denial.
    const resolved = access.resolveIssueAddress(input.issue)
    issueId = resolved.kind === 'issue' ? resolved.id : UNADDRESSABLE
    checkIssueAccess(caller, issues, 'agent.spawn', 'write', issueId)
  } else if (input.newTitle) {
    if (!deps.createIssue) throw new Error('issue creation is not wired on this server')
    // Deliberate --new: inherit the caller's repo/parent from its own issue
    // scope when it has one (keeps the child inside the parent's subtree);
    // otherwise --repo names the repository explicitly.
    //
    // OWNERSHIP (contract `ownership`, ADR 9 D5 A4 / §3 O4): the issue created
    // here is owned by the on-behalf-of HUMAN with the spawning agent as actor,
    // and when it has a parent issue it inherits that issue's owner and grants
    // rather than the actor's — sharing an issue shares the work done on it.
    // The rule lives in the contract; this is the site that obeys it.
    const scopeIssue =
      caller.capability.scope.kind === 'subtree'
        ? issues.getMeta(caller.capability.scope.rootId ?? '')
        : null
    const repoPath = input.repo ?? scopeIssue?.repoPath
    if (!repoPath) throw new Error('--new needs --repo (no issue scope to inherit a repo from)')
    const inheritedOwner = scopeIssue
      ? (issues.ownedTarget(scopeIssue.id, 'read')?.owner ?? callerOwner)
      : callerOwner
    issueId = deps.createIssue({
      ownerUserId: inheritedOwner,
      createdByActor: attribution.actor,
      createdByOnBehalfOf: callerOwner,
      repoPath,
      title: input.newTitle,
      description: input.prompt,
      ...(scopeIssue ? { parentId: scopeIssue.id } : {}),
      origin: caller.capability.scope.kind === 'all' ? 'human' : 'agent',
    }).id
  } else {
    throw new Error('pass --issue <ref> or --new "title"')
  }
  const issue = issues.getMeta(issueId)
  if (!issue) throw new Error(`unknown issue ${issueId}`)
  // Brake 2 applies to DIRECT agent spawns too [spec:SP-34d7 containment]:
  // the same per-issue daily budget as the spawn-on-wake seam, or a looping
  // agent (or its spawned children re-spawning) fork-bombs the host with
  // full PTY sessions. Human intent is never braked (contract: the exemption
  // attaches to a human principal, not to an admin grade).
  const budgeted = caller.capability.scope.kind !== 'all'
  if (budgeted && !deps.messages().takeSpawnBudget(issueId).ok) {
    try {
      deps.appendEvent?.({
        ts: deps.now?.() ?? new Date().toISOString(),
        kind: 'agent.spawn_budget_exhausted',
        subject: issueId,
        payload: { issueId, caller: caller.capability.actorSessionId ?? null },
      })
    } catch {}
    throw new Error(
      `spawn budget exhausted for issue #${issue.seq} (${SPAWN_BUDGET_PER_DAY}/day); ` +
        'message the issue instead, or ask the operator',
    )
  }
  if (input.worktree && !issue.worktreePath) {
    // Starting an issue (worktree + branch) stays a deliberate coordinator
    // action — podium issue start owns that flow; spawn never forks a second one.
    throw new Error(`issue #${issue.seq} has no worktree — run \`podium issue start\` first`)
  }
  const cwd = issue.worktreePath ?? issue.repoPath
  const spawnedBy = caller.capability.actorSessionId
    ? `session:${caller.capability.actorSessionId}`
    : caller.capability.scope.kind === 'all'
      ? 'user'
      : 'agent'
  const profile = input.executionProfileId
    ? deps.resolveExecutionProfile?.({
        profileId: input.executionProfileId,
        caller,
        ...(input.workflowRunId ? { runId: input.workflowRunId } : {}),
        ...(input.workflowStepId ? { stepId: input.workflowStepId } : {}),
      })
    : undefined
  const harness = profile?.harness ?? input.harness ?? issue.defaultAgent
  const model = profile?.model ?? input.model
  const effort = profile?.effort ?? input.effort
  const machineId = profile?.machineId ?? issue.machineId
  // MACHINE PLACEMENT FAILS CLOSED — readiness §3.1.4 M1/M5/M6.
  //
  // `use` is a code-execution boundary, not a privacy one: it means arbitrary
  // execution on someone's hardware with their SSH keys, git identity, dotfiles
  // and checked-out private repos. Checked against the EFFECTIVE principal, so
  // an agent reaches exactly the machines its human may use and a sub-agent
  // cannot reach past its parent — one check, not a separate fleet ACL.
  //
  // The two failures stay DISTINGUISHABLE, which is the deliberate opposite of
  // the address rule above: "denied" and "offline" otherwise produce the same
  // empty list and nobody can tell a permissions problem from a dead machine.
  // Authorization is decided before reachability, so an unauthorized caller
  // cannot read the difference to probe which machines are online. A denied
  // placement is a DENIAL — never a silent retarget onto a machine the caller
  // may use, which would run their code somewhere they did not choose.
  if (machineId) {
    const decision = access.placement(machineId)
    if (decision === 'unauthorized') {
      throw new Error(
        `not allowed to run agents on machine ${machineId}; ask its owner to grant you 'use'`,
      )
    }
    if (decision === 'unreachable') {
      throw new Error(`machine ${machineId} is not reachable right now`)
    }
  }
  const sessionOwner = issues.ownedTarget(issue.id, 'read')?.owner ?? callerOwner
  const spawned = deps.spawnSession({
    ownerUserId: sessionOwner,
    cwd,
    agentKind: harness,
    initialPrompt: input.prompt,
    // `issue.id` (branded), NOT the local `issueId`: that local may hold
    // UNADDRESSABLE, a DELIBERATE non-id sentinel (see packages/commands'
    // ceiling.ts). Branding it would launder the sentinel, the same mistake the
    // MachineId carve-out exists to prevent. By here the row has been resolved
    // and the throw above has fired, so the row's own id is the honest source.
    issueId: issue.id,
    spawnedBy,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(profile ? { accountId: profile.accountId } : {}),
    ...(input.force ? { forceUnknownModel: true } : {}),
    ...(machineId ? { machineId } : {}),
    // CLI `--title` → curated name slot (not derived title) [spec:SP-4ef9][spec:SP-eb60].
    ...(input.title ? { name: input.title } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
    ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
  })
  const sessionId = spawned.sessionId
  const actualHarness = spawned.harness ?? harness
  const actualModel = spawned.model === undefined ? model : (spawned.model ?? undefined)
  const actualEffort = spawned.effort === undefined ? effort : (spawned.effort ?? undefined)
  const actualMachineId = spawned.machineId ?? machineId
  const actualAccountId =
    spawned.accountId === undefined ? profile?.accountId : (spawned.accountId ?? undefined)
  try {
    deps.appendEvent?.({
      ts: deps.now?.() ?? new Date().toISOString(),
      kind: 'agent.spawned',
      subject: sessionId,
      payload: {
        sessionId,
        issueId,
        spawnedBy,
        // budgetIssue rides the durable event so brake 2 survives restarts
        // (spawnCountFor counts it); absent on unbudgeted operator spawns.
        ...(budgeted ? { budgetIssue: issueId } : {}),
        harness: actualHarness,
        ...(actualModel ? { model: actualModel } : {}),
        ...(actualEffort ? { effort: actualEffort } : {}),
        ...(actualMachineId ? { machineId: actualMachineId } : {}),
        ...(actualAccountId ? { accountId: actualAccountId } : {}),
        ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
        ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
        ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      },
    })
  } catch {}
  return {
    ok: true,
    sessionId,
    issueId,
    issueSeq: issue.seq,
    cwd,
    agentId: spawned.agentId ?? sessionId,
    harness: actualHarness,
    model: actualModel ?? null,
    effort: actualEffort ?? null,
    machine: spawned.machine ?? actualMachineId ?? null,
  }
}
