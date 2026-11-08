import { commandAccess } from '../../issues/command-ctx'
/**
 * Handler for the `mail.spawnAgent` contract (L3).
 *
 * `podium agent spawn`: a full Podium session on the target issue, via the ONE
 * spawn path (SessionLifecycle.createSession). The caller becomes the child's
 * parent (`spawnedBy 'session:<id>'`) — which is what unlocks the parent-grade
 * clamps (interrupt + wake) the clamp matrix already implements. No issue is
 * EVER auto-created: `newTitle` is the explicit --new path.
 *
 * TWO gates, per the contract: write access to the target issue, and `use` on
 * the machine the child is placed on.
 */

import { randomUUID } from 'node:crypto'
import { type ContractInput, type spawnAgentContract, UNADDRESSABLE } from '@podium/commands'
import {
  asIssueId,
  asMutationId,
  isPersonCapability,
  type MachineId,
  type SessionId,
  spawnedByTag,
  type UserId,
} from '@podium/model'
import { attributionOf, onBehalfOfUser } from '../../../command-principal'
import { checkIssueAccess } from '../../../issue-authz'
import type { IssueRow } from '../../../store'
import { SPAWN_BUDGET_PER_DAY } from '../brakes'
import { MailRefusal } from '../refusal'
import { type MailHandlerContext, mailWriter } from './context'

/**
 * THE SPAWN BUDGET REFUSED A SPAWN (brake 2). A refusal; its event is the
 * trail of it, written outside the write it refused (POD-6525).
 */
export class SpawnBudgetExhausted extends MailRefusal {
  constructor(
    readonly issueId: string,
    readonly callerSession: string | null,
    message: string,
  ) {
    super('conflict', message)
  }

  /** The durable trail of the refusal. */
  event(now: string) {
    return {
      ts: now,
      kind: 'agent.spawn_budget_exhausted',
      subject: this.issueId,
      payload: { issueId: this.issueId, caller: this.callerSession },
    }
  }
}

export async function spawnAgentHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof spawnAgentContract>,
): Promise<unknown> {
  // ONE CHILD PER REQUEST ID (POD-4763). The CLI mints the id before its first
  // attempt and repeats it only when no answer came back, so a repeat is
  // answered with the child the first attempt started. The ledger joins a
  // repeat that arrives while the first is still running.
  //
  // On the sync write entry point (POD-6525) the entry point's own dedup by the
  // same id is that ledger, and the spawn is a `session.launch` record.
  if (ctx.inEntry && ctx.deps.spawnRecord) return await spawnThroughRecord(ctx, input)
  const mutations = ctx.deps.mutations
  if (!input.requestId || !mutations) return await spawnOnce(ctx, input)
  return await mutations.once(asMutationId(input.requestId), 'mail.spawnAgent', () =>
    spawnOnce(ctx, input),
  )
}

/** What a spawn decided and checked before anything starts. */
interface SpawnPlan {
  readonly issueId: string
  readonly issue: IssueRow
  readonly budgeted: boolean
  readonly budget: { ok: boolean; count: number } | null
  readonly cwd: string
  readonly spawnedBy: string
  readonly harness: string | undefined
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly machineId: MachineId | undefined
  readonly agentProfileId: string | undefined
  readonly sessionOwner: UserId
}

/** The direct spawn: a fixture's gate, or one with no record port. */
async function spawnOnce(
  ctx: MailHandlerContext,
  input: ContractInput<typeof spawnAgentContract>,
): Promise<unknown> {
  const { deps } = ctx
  if (!deps.spawnSession) throw new Error('agent spawn is not wired on this server')
  const plan = await planSpawn(ctx, input)
  const { issue, issueId, cwd, spawnedBy, harness, model, effort, machineId, agentProfileId } = plan
  // A newly attached daemon is online before its first probe completes. Wait for
  // that current-connection fact instead of letting SessionStart judge the
  // persisted snapshot from the previous connection. The wait stays below the
  // relay deadline; on expiry SessionStart returns the honest probing refusal.
  if (machineId && harness !== 'shell') await deps.awaitMachineInventory?.(machineId)
  const spawned = await deps.spawnSession({
    ownerUserId: plan.sessionOwner,
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
    ...(input.force ? { forceUnknownModel: true } : {}),
    ...(machineId ? { machineId } : {}),
    // CLI `--title` → curated name slot (not derived title) [spec:SP-4ef9][spec:SP-eb60].
    ...(input.title ? { name: input.title } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
    ...(agentProfileId ? { agentProfileId } : {}),
  })
  const sessionId = spawned.sessionId
  const actualHarness = spawned.harness ?? harness
  const actualModel = spawned.model === undefined ? model : (spawned.model ?? undefined)
  const actualEffort = spawned.effort === undefined ? effort : (spawned.effort ?? undefined)
  const actualMachineId = spawned.machineId ?? machineId
  const actualAccountId = spawned.accountId ?? undefined
  try {
    await deps.appendEvent?.(
      spawnedEvent(ctx, plan, input, sessionId, {
        harness: actualHarness,
        model: actualModel,
        effort: actualEffort,
        machineId: actualMachineId,
        accountId: actualAccountId,
      }),
    )
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
    ...(spawned.promptMessageId ? { promptMessageId: spawned.promptMessageId } : {}),
    // Shown on success so a fan-out can plan before the brake refuses (POD-2062).
    ...(plan.budget
      ? { spawnBudget: { used: plan.budget.count, limit: SPAWN_BUDGET_PER_DAY } }
      : {}),
  }
}

/**
 * THE SPAWN AS A WRITE (POD-6525). Everything the spawn decides and checks
 * runs in the write's unit of work: the issue a `--new` creates, the budget
 * (its `agent.spawned` event is the durable count), the placement. The start
 * itself is a `session.launch` record under a session id minted here, created
 * in the same unit: its run starts the child once per id, after checking the
 * writer again. The write answers with what it decided and the record's id;
 * the gate's adapter waits for the record and answers the old shape.
 *
 * The task rides the record as its first prompt; the start stores it as the
 * spawner's message, as it always did, because an agent that takes its first
 * prompt on its command line never had one.
 */
async function spawnThroughRecord(
  ctx: MailHandlerContext,
  input: ContractInput<typeof spawnAgentContract>,
): Promise<unknown> {
  const record = ctx.deps.spawnRecord
  if (record === undefined) throw new Error('agent spawn is not wired on this server')
  if (ctx.writer === undefined) throw new Error('agent spawn: its launch is created in its write')
  const plan = await planSpawn(ctx, input)
  const { issue, issueId, cwd, spawnedBy, harness, model, effort, machineId, agentProfileId } = plan
  // No daemon to start on now is refused now, as the start always refused it.
  await record.refuseUnplaceable(ctx.caller.principal, {
    ...(machineId ? { machineId } : {}),
    cwd,
    ...(harness ? { agentKind: harness } : {}),
  })
  const sessionId = randomUUID() as SessionId
  const { effectId } = await record.create(ctx.writer, ctx.caller.principal, {
    sessionId,
    input: {
      ...(harness ? { agentKind: harness } : {}),
      cwd,
      initialPrompt: input.prompt,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(input.force ? { forceUnknownModel: true } : {}),
      issueId: issue.id,
      ...(machineId ? { machineId } : {}),
      spawnAgent: {
        ownerUserId: plan.sessionOwner,
        spawnedBy,
        ...(input.title ? { name: input.title } : {}),
        ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
        ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
        ...(agentProfileId ? { agentProfileId } : {}),
      },
    },
  })
  // The budget's durable count, in the write: it commits with the record.
  await ctx.deps.appendEvent?.(
    spawnedEvent(ctx, plan, input, sessionId, { harness, model, effort, machineId }),
  )
  return {
    ok: true,
    sessionId,
    issueId,
    issueSeq: issue.seq,
    cwd,
    agentId: sessionId,
    harness,
    model: model ?? null,
    effort: effort ?? null,
    machine: machineId ?? null,
    ...(plan.budget
      ? { spawnBudget: { used: plan.budget.count, limit: SPAWN_BUDGET_PER_DAY } }
      : {}),
    // The start's record: where the spawn stands, on every device.
    effectId,
  }
}

/** The `agent.spawned` event: the durable count brake 2 reads. */
function spawnedEvent(
  ctx: MailHandlerContext,
  plan: SpawnPlan,
  input: ContractInput<typeof spawnAgentContract>,
  sessionId: string,
  actual: {
    harness: string | undefined
    model: string | undefined
    effort: string | undefined
    machineId: MachineId | undefined
    accountId?: string | undefined
  },
) {
  return {
    ts: ctx.deps.now?.() ?? new Date().toISOString(),
    kind: 'agent.spawned',
    subject: sessionId,
    payload: {
      sessionId,
      issueId: plan.issueId,
      spawnedBy: plan.spawnedBy,
      // budgetIssue rides the durable event so brake 2 survives restarts
      // (spawnCountFor counts it); absent on unbudgeted operator spawns.
      ...(plan.budgeted ? { budgetIssue: plan.issueId } : {}),
      harness: actual.harness,
      ...(actual.model ? { model: actual.model } : {}),
      ...(actual.effort ? { effort: actual.effort } : {}),
      ...(actual.machineId ? { machineId: actual.machineId } : {}),
      ...(actual.accountId ? { accountId: actual.accountId } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(plan.agentProfileId ? { agentProfileId: plan.agentProfileId } : {}),
    },
  }
}

/** Decide and check a spawn: its issue, budget, folder, agent and machine. */
async function planSpawn(
  ctx: MailHandlerContext,
  input: ContractInput<typeof spawnAgentContract>,
): Promise<SpawnPlan> {
  const { caller, deps, access } = ctx
  if (!caller.principal) throw new MailRefusal('unauthorized', 'agent spawn requires an authenticated principal')
  const attribution = attributionOf(caller.principal)
  const callerOwner = onBehalfOfUser(caller.principal)
  if (callerOwner === null) throw new MailRefusal('unauthorized', 'agent spawn requires a human owner')
  const issues = deps.issues
  if (input.issue && input.newTitle) {
    throw new MailRefusal('invalid', 'pass --issue OR --new, not both')
  }
  let issueId: string
  if (input.issue) {
    // Under the human ceiling, exactly as on the send path: an issue beyond the
    // delegating human's visibility must fail as an unknown issue, so it takes
    // the `unknown issue` branch below rather than a distinguishable denial.
    const resolved = await access.resolveIssueAddress(input.issue)
    issueId = resolved.kind === 'issue' ? resolved.id : UNADDRESSABLE
    await checkIssueAccess(caller, commandAccess(issues), 'agent.spawn', 'write', issueId)
  } else if (input.newTitle) {
    if (!deps.createIssue) throw new Error('issue creation is not wired on this server')
    // Deliberate --new: inherit the caller's repo/parent from its own issue
    // scope when it has one (keeps the child inside the parent's subtree);
    // otherwise --repo names the repository explicitly.
    //
    // OWNERSHIP (contract `ownership`, ADR 9 D5 A4 / §3 O4): the issue created
    // here is owned by the on-behalf-of HUMAN with the spawning agent as actor.
    // Its assignee is that human even under someone else's task (POD-6287,
    // design §2.2: a new task defaults to the creating human, for an agent its
    // delegating human); it used to take the parent's owner, which handed Bob's
    // agent's new task to Alice. The rule lives in the contract; this is the
    // site that obeys it.
    const scopeIssue =
      caller.capability.scope.kind === 'subtree'
        ? await issues.reports.getMeta(caller.capability.scope.rootId ?? '')
        : null
    const repoPath = input.repo ?? scopeIssue?.repoPath
    if (!repoPath) {
      throw new MailRefusal('invalid', '--new needs --repo (no issue scope to inherit a repo from)')
    }
    issueId = (
      await deps.createIssue(mailWriter(ctx, 'mail.spawnAgent'), {
        ownerUserId: callerOwner,
        createdByActor: attribution.actor,
        createdByOnBehalfOf: callerOwner,
        repoPath,
        title: input.newTitle,
        description: input.prompt,
        ...(scopeIssue ? { parentId: scopeIssue.id } : {}),
        origin: isPersonCapability(caller.capability) ? 'human' : 'agent',
      })
    ).id
  } else {
    throw new MailRefusal('invalid', 'pass --issue <ref> or --new "title"')
  }
  const issue = await issues.reports.getMeta(issueId)
  if (!issue) throw new MailRefusal('target-not-found', `unknown issue ${issueId}`)
  // Brake 2 applies to DIRECT agent spawns too [spec:SP-34d7 containment]:
  // the same per-issue daily budget as the spawn-on-wake seam, or a looping
  // agent (or its spawned children re-spawning) fork-bombs the host with
  // full PTY sessions. Human intent is never braked (contract: the exemption
  // attaches to a human principal, not to an admin grade).
  const budgeted = !isPersonCapability(caller.capability)
  const budget = budgeted ? await deps.messages.takeSpawnBudget(asIssueId(issueId)) : null
  if (budget && !budget.ok) {
    const exhausted = new SpawnBudgetExhausted(
      issueId,
      caller.capability.actorSessionId ?? null,
      `spawn budget exhausted for issue #${issue.seq} (${SPAWN_BUDGET_PER_DAY}/day, resets 00:00 UTC); ` +
        'nothing was spawned. Mail a live session on the issue, or ask your coordinator or the operator',
    )
    // In a write, the trail is written after it rolled back (`rolledBack`).
    if (!ctx.inEntry) {
      try {
        await deps.appendEvent?.(exhausted.event(deps.now?.() ?? new Date().toISOString()))
      } catch {}
    }
    throw exhausted
  }
  if (input.worktree && !issue.worktreePath) {
    // Starting an issue (worktree + branch) stays a deliberate coordinator
    // action — podium issue start owns that flow; spawn never forks a second one.
    throw new MailRefusal(
      'conflict',
      `issue #${issue.seq} has no worktree — run \`podium issue start\` first`,
    )
  }
  const cwd = issue.worktreePath ?? issue.repoPath
  const spawnedBy = spawnedByTag(
    caller.capability.actorSessionId
      ? { kind: 'session', id: caller.capability.actorSessionId }
      : isPersonCapability(caller.capability)
        ? { kind: 'user' }
        : { kind: 'agent' },
  )
  // A WORKFLOW STEP that pins an agent profile launches from that profile as
  // the run pinned it (POD-6114). It is the step's own setup, so another
  // --profile is refused rather than silently winning or losing.
  const step =
    input.workflowRunId && input.workflowStepId
      ? await deps.resolveWorkflowStepLaunch?.({
          runId: input.workflowRunId,
          stepId: input.workflowStepId,
          cwd,
          caller,
        })
      : null
  let agentProfileId: string | undefined
  if (input.agentProfile) {
    const found = await deps.findAgentProfile?.(input.agentProfile)
    if (!found) {
      throw new MailRefusal(
        'invalid',
        `no agent profile '${input.agentProfile}' — see \`podium profile list\``,
      )
    }
    if (step && found.id !== step.profile.id) {
      throw new MailRefusal(
        'invalid',
        `workflow step ${input.workflowStepId} runs with agent profile '${step.profile.name}'; ` +
          `drop --profile ${input.agentProfile}`,
      )
    }
    agentProfileId = found.id
  } else if (step) {
    agentProfileId = step.profile.id
  } else if (issue.agentProfileId) {
    agentProfileId = issue.agentProfileId
  }
  // An explicit --profile replaces the issue's agent pick rather than being
  // filtered by it; SessionStart resolves the profile's first usable candidate.
  // A pinned step's pick is already made, and is passed on as it is.
  const harness =
    step?.agentKind ?? input.harness ?? (input.agentProfile ? undefined : issue.defaultAgent)
  const model = step?.model ?? input.model
  const effort = step?.effort ?? input.effort
  const machineId = step?.machineId ?? issue.machineId
  /**
   * A DELEGATE CANNOT CROSS MACHINES AWAY FROM ITS ISSUE'S WORKTREE (POD-1386).
   *
   * `cwd` above is the issue's worktree path, and a worktree exists on exactly one
   * machine. Spawning onto a different one sends that path to a host where it does
   * not exist — so the delegate either lands somewhere unrelated or a second
   * checkout of one branch appears on a second machine. Both LOOK like a
   * successful spawn: the command returns an agent id, the sidebar shows a
   * session, and the divergence only surfaces later as work that cannot be merged.
   *
   * This is reachable only through a workflow step's agent profile, which is the
   * one input that can name a machine independently of the issue
   * (`step?.machineId ?? issue.machineId`) — every other caller inherits the
   * issue's home and is therefore already correct.
   *
   * REFUSING IS THE WHOLE ANSWER, not a fallback. Silently retargeting to the
   * issue's machine would ignore a placement the human configured, and silently
   * honouring the profile would fork the worktree. The one operation that MOVES a
   * worktree between machines is `sessions.handoff`, so the refusal names it.
   *
   * An issue with no worktree yet has nothing to diverge from, and a start on a
   * pinned machine is a legitimate way to home it — so the guard keys on the
   * worktree's existence, not on the pin.
   */
  if (issue.worktreePath && machineId && issue.machineId && machineId !== issue.machineId) {
    throw new MailRefusal(
      'conflict',
      `issue ${issue.id} is homed on machine ${issue.machineId} and its worktree lives there; ` +
        `spawning on ${machineId} would create a second checkout of the same branch. ` +
        'Hand the session off to that machine first (`podium session handoff <id> --to <machine>`), ' +
        "or clear the agent profile's machine.",
    )
  }
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
      throw new MailRefusal(
        'unauthorized',
        `not allowed to run agents on machine ${machineId}; ask its owner to grant you 'use'`,
      )
    }
    if (decision === 'unreachable') {
      throw new MailRefusal('conflict', `machine ${machineId} is not reachable right now`)
    }
  }
  // A child acts for its spawning human, regardless of the task's assignee.
  const sessionOwner = callerOwner
  return {
    issueId,
    issue,
    budgeted,
    budget,
    cwd,
    spawnedBy,
    harness,
    model,
    effort,
    machineId: machineId ?? undefined,
    agentProfileId,
    sessionOwner,
  }
}
