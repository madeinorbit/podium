import type {
  AgentKind,
  IssueBoardStage,
  IssueId,
  MachineId,
  MutationId,
  RepoId,
  SessionId,
} from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'

/** Where a new agent lands: a worktree path + its owning repo (+ machine). */
export interface SpawnTarget {
  path: string
  repoPath: string
  /* Stable project identity used to keep optimistic sidebar rows in the same
   * group as their reconciled server row. */
  repoId?: RepoId
  machineId?: MachineId
  placement?: 'allowed' | 'unauthorized' | 'unreachable'
}

/** A named-task start: `started` once its `issue.start` record is durably
 *  queued (a later failure shows on its task), `failed` when it never was. */
export type TaskSpawnOutcome = 'started' | 'failed'

type DraftSpawnReservation =
  | { sessionId: SessionId; issueId: IssueId; mutationId: MutationId }
  | { sessionId?: never; issueId?: never; mutationId?: never }

/** Retry identity is one reservation, not three independent switches. Reusing
 *  a mutation receipt with freshly-minted entity ids cannot reconcile. */
export type SpawnDraftAgentArgs = DraftSpawnReservation & {
  /** Files uploaded for this task and held on the server (POD-2148). */
  attachments?: RuntimeAttachmentRef[]
  target: SpawnTarget
  agentKind: AgentKind
  firstPrompt?: string
  model?: string
  effort?: string
  /** The per-spawn driver override, forwarded verbatim — see `sessions.create`
   *  in `api.ts`. Absent changes nothing, which is every caller today. */
  requestedDriverId?: string
}

/** A named task with its first agent, as the `issue.start` it is (POD-6410). */
export interface SpawnIssueAgentArgs {
  issueId?: IssueId
  sessionId?: SessionId
  mutationId?: MutationId
  target: SpawnTarget
  title: string
  description: string
  brief?: string
  parentBranch?: string
  /** The agent it starts, and what every device paints while it waits. */
  agentKind: AgentKind
  /** Leave the task on the configured default agent: `agentKind` is then only
   *  what this device paints, and the server resolves the agent at run time. */
  inheritAgent?: boolean
  model?: string
  effort?: string
  /** 0–4; absent, the family's default. */
  priority?: number
  /** Where the task is moved once started; absent, it reads In progress. */
  stage?: IssueBoardStage
}

/**
 * The network half of the "New <Agent> in <Repo>" spawn: create the session (in a
 * fresh draft-issue vessel) on the server, then deliver an optional first prompt.
 *
 * The caller mints `sessionId` + `issueId` client-side and passes them here so the
 * server reuses them verbatim (issue #119) — that's what lets the store paint an
 * optimistic row that reconciles by id when the broadcast lands. This function does
 * NOT touch UI state; `store.spawnDraftAgent` wraps it with the optimistic overlay
 * (instant row + rollback-on-failure). Rejects if the create fails, so the wrapper
 * can roll back.
 *
 * `firstPrompt` rides `sessions.create.initialPrompt`. SessionStart launches it
 * on argv-capable harnesses (claude/codex/grok), and sends every other harness
 * through its durable outbox once the session can accept input.
 */
export class SpawnPlacementError extends Error {
  constructor(readonly reason: 'unauthorized' | 'unreachable') {
    super(
      reason === 'unauthorized'
        ? 'not authorized to use that machine'
        : 'target machine is unreachable',
    )
    this.name = 'SpawnPlacementError'
  }
}

/**
 * Harnesses whose first prompt is a launch argv token, read off the served
 * (or bundled) descriptors — never a client-side mirror of
 * `packages/harness` `capabilities.argvPrompt` (the old `ARGV_PROMPT_HARNESSES`
 * set drifted: it denied opencode an argv prompt its manifest declares).
 * Injected, so client-core takes no harness dependency. Unknown harnesses
 * and a missing report fail closed: the prompt travels the durable outbox.
 */
export function agentAcceptsArgvPrompt(
  kind: string,
  descriptors: readonly HarnessDescriptorWire[] | undefined,
): boolean {
  return descriptors?.some((d) => d.kind === kind && d.capabilities.argvPrompt) ?? false
}

/**
 * Refuse a placement before any optimistic entity is painted or network request
 * is assembled. Engine calls this at its action boundary; `draftLaunchEffect`,
 * `sessionLaunchEffect` and `issueStartEffect` repeat it as defense in depth
 * for direct callers.
 */
export function assertSpawnPlacement(target: SpawnTarget): void {
  if (target.placement === 'unauthorized') throw new SpawnPlacementError('unauthorized')
  if (target.placement === 'unreachable') throw new SpawnPlacementError('unreachable')
}

/** The effect kind a session start is (POD-6398): the server's executor. */
export const SESSION_LAUNCH_KIND = 'session.launch'

/** What `effects.create` takes (POD-6357), as the outbox queues it. */
export interface EffectCreateInput {
  readonly id: string
  readonly kind: string
  readonly target: { readonly kind: 'issue' | 'session' | 'machine'; readonly id: string }
  readonly input: Readonly<Record<string, unknown>>
  readonly deadlineMs?: number
}

/**
 * A draft-agent start as a `session.launch` effect record (POD-6408): the same
 * spec `sessions.create` took, under an effect id and with the session id the
 * device minted as its target. The record is what every device paints while
 * the launch waits (also while its machine is offline), and the session row is
 * born under that id when it succeeds.
 */
export function draftLaunchEffect(args: {
  effectId: string
  sessionId: SessionId
  issueId: IssueId
  attachments?: RuntimeAttachmentRef[]
  target: SpawnTarget
  agentKind: AgentKind
  firstPrompt?: string
  model?: string
  effort?: string
  requestedDriverId?: string
}): EffectCreateInput {
  assertSpawnPlacement(args.target)
  const text = args.firstPrompt?.trim()
  return {
    id: args.effectId,
    kind: SESSION_LAUNCH_KIND,
    target: { kind: 'session', id: args.sessionId },
    input: {
      agentKind: args.agentKind,
      cwd: args.target.path,
      draftIssue: { repoPath: args.target.repoPath, issueId: args.issueId },
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      ...(args.target.machineId ? { machineId: args.target.machineId } : {}),
      ...(text ? { initialPrompt: text } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.requestedDriverId !== undefined
        ? { requestedDriverId: args.requestedDriverId }
        : {}),
    },
  }
}

/** A plain session start (POD-6523): no draft task, no first prompt. */
export interface LaunchSessionArgs {
  /** The id to start under; minted when absent. */
  sessionId?: SessionId
  /** Where it runs: the folder and, when chosen, the machine. */
  target: SpawnTarget
  agentKind: AgentKind
  /** The existing task it joins; absent, it joins none. */
  issueId?: IssueId
  /** The per-spawn driver override, forwarded verbatim (`sessions.create`). */
  requestedDriverId?: string
}

/**
 * A plain session start as a `session.launch` effect record (POD-6523): the
 * panel menu's "new agent here", in a folder and, when it has one, the task the
 * panel shows. Like a draft start, the device mints the session id, and the
 * record is what every device paints until the row is born under it.
 */
export function sessionLaunchEffect(args: {
  effectId: string
  sessionId: SessionId
  target: SpawnTarget
  agentKind: AgentKind
  issueId?: IssueId
  requestedDriverId?: string
}): EffectCreateInput {
  assertSpawnPlacement(args.target)
  return {
    id: args.effectId,
    kind: SESSION_LAUNCH_KIND,
    target: { kind: 'session', id: args.sessionId },
    input: {
      agentKind: args.agentKind,
      cwd: args.target.path,
      ...(args.target.machineId ? { machineId: args.target.machineId } : {}),
      ...(args.issueId ? { issueId: args.issueId } : {}),
      ...(args.requestedDriverId !== undefined
        ? { requestedDriverId: args.requestedDriverId }
        : {}),
    },
  }
}

/** The effect kind changing a running session's model or effort is (POD-6416). */
export const SESSION_CONFIGURE_KIND = 'session.configure'

/**
 * A model or effort change on a running session as a `session.configure`
 * effect record (POD-6523): the patch, each field only when it changes, with
 * the session as its target. The server asks the session's driver once; the
 * record carries the driver's answer (`{ ok, effective }` or its refusal).
 */
export function sessionConfigureEffect(args: {
  effectId: string
  sessionId: SessionId
  model?: string
  effort?: string
}): EffectCreateInput {
  if (args.model === undefined && args.effort === undefined) {
    throw new Error('session.configure: name a model or an effort to change')
  }
  return {
    id: args.effectId,
    kind: SESSION_CONFIGURE_KIND,
    target: { kind: 'session', id: args.sessionId },
    input: {
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.effort !== undefined ? { effort: args.effort } : {}),
    },
  }
}

/** The effect kind filing a task with its first agent is (POD-6410). */
export const ISSUE_START_KIND = 'issue.start'

/** An `issue.start` record's error code when the task was filed as a
 *  proposal (a member's top-level task): expected, not a failure. */
export const ISSUE_START_PROPOSED = 'proposed'

/** The effect id a start's reservation names: a retry of the same start (the
 *  composer keeps its ids) writes the same record, never a second one. */
export function startEffectId(mutationId: MutationId | undefined, mint: () => string): string {
  return mutationId !== undefined && UUID.test(mutationId) ? `eff_${mutationId}` : `eff_${mint()}`
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A named task with its first agent as an `issue.start` effect record
 * (POD-6410): `issues.create`'s fields under an effect id, the issue id the
 * device minted as its target and the session id it minted in its input. Every
 * device paints the starting task from it while it waits, and the issue and
 * session rows are born under those ids when it runs. Priority and the chosen
 * stage ride it too (POD-6421).
 */
export function issueStartEffect(
  args: Omit<SpawnIssueAgentArgs, 'issueId' | 'sessionId' | 'mutationId'> & {
    effectId: string
    sessionId: SessionId
    issueId: IssueId
  },
): EffectCreateInput {
  assertSpawnPlacement(args.target)
  return {
    id: args.effectId,
    kind: ISSUE_START_KIND,
    target: { kind: 'issue', id: args.issueId },
    input: {
      sessionId: args.sessionId,
      repoPath: args.target.repoPath,
      ...(args.target.machineId ? { machineId: args.target.machineId } : {}),
      title: args.title,
      description: args.description,
      ...(args.brief ? { brief: args.brief } : {}),
      ...(args.parentBranch ? { parentBranch: args.parentBranch } : {}),
      ...(args.inheritAgent ? {} : { defaultAgent: args.agentKind }),
      ...(args.model ? { defaultModel: args.model } : {}),
      ...(args.effort ? { defaultEffort: args.effort } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.stage !== undefined ? { stage: args.stage } : {}),
    },
  }
}

/**
 * THE ISSUE'S OWN WORK AS EFFECT RECORDS (POD-6414, moved to the apps by
 * POD-6526). Starting an existing issue, adding an agent or a shell to it,
 * stopping it, cleaning it up, shipping it and refreshing its assistant are
 * each an effect record targeting the issue, created through `effects.create`
 * (the outbox's `effectCreate`). The server's executors are in
 * `apps/server/src/modules/issues/work-effects.ts`; the old `issues.*` routes
 * stay as adapters onto them for older clients.
 */
export const ISSUE_BEGIN_KIND = 'issue.begin'
export const ISSUE_ADD_SESSION_KIND = 'issue.addSession'
export const ISSUE_STOP_KIND = 'issue.stop'
export const ISSUE_CLEANUP_KIND = 'issue.cleanup'
export const ISSUE_SHIP_KIND = 'issue.ship'
export const ISSUE_ASSISTANT_KIND = 'issue.assistant'

/** The kinds that act on an existing issue's work (not `issue.start`, which
 *  files a new one). */
export const ISSUE_WORK_KINDS: ReadonlySet<string> = new Set([
  ISSUE_BEGIN_KIND,
  ISSUE_ADD_SESSION_KIND,
  ISSUE_STOP_KIND,
  ISSUE_CLEANUP_KIND,
  ISSUE_SHIP_KIND,
  ISSUE_ASSISTANT_KIND,
])

/**
 * A session start on an existing issue: `begin` cuts its worktree and starts
 * its first session (`issues.start`); `agent` and `shell` add one to a started
 * issue (`issues.addSession`, `issues.addShell`).
 */
export type IssueSessionMode = 'begin' | 'agent' | 'shell'

/** What starting a session on an existing issue takes (POD-6526). */
export interface StartIssueSessionArgs {
  issueId: IssueId
  /** `agent` when absent: one more agent, or the first when the issue has
   *  never been started (no branch yet). */
  mode?: IssueSessionMode
  /** The id to start under; minted when absent. */
  sessionId?: SessionId
  /** A retry of the same start writes the same record (`startEffectId`). */
  mutationId?: MutationId
  agentKind?: AgentKind | string
  /** `begin` only: persisted onto the issue as its profile. */
  model?: string
  effort?: string
  forceUnknownModel?: boolean
}

/** The store action that starts one (`Store.startIssueSession`). */
export type StartIssueSession = (args: StartIssueSessionArgs) => {
  sessionId: SessionId
  effectId: string
  mode: IssueSessionMode
  /** True once its record is durably queued; false when it never was (that
   *  failure is told once, on this device). */
  settled: Promise<boolean>
}

/**
 * A session start on an existing issue as its effect record: `issue.begin`
 * or `issue.addSession` (`shell: true` for a shell), with the session id the
 * device minted in its input. The launch paint shows the starting session
 * from it, on the issue, until the row is born under that id.
 */
export function issueSessionEffect(args: {
  effectId: string
  issueId: IssueId
  sessionId: SessionId
  mode: IssueSessionMode
  agentKind?: AgentKind | string
  model?: string
  effort?: string
  forceUnknownModel?: boolean
}): EffectCreateInput {
  const force = args.forceUnknownModel === true ? { forceUnknownModel: true } : {}
  const agent = args.agentKind !== undefined ? { agentKind: args.agentKind } : {}
  const target = { kind: 'issue' as const, id: args.issueId }
  if (args.mode === 'begin') {
    return {
      id: args.effectId,
      kind: ISSUE_BEGIN_KIND,
      target,
      input: {
        sessionId: args.sessionId,
        ...agent,
        ...(args.model ? { defaultModel: args.model } : {}),
        ...(args.effort ? { defaultEffort: args.effort } : {}),
        ...force,
      },
    }
  }
  return {
    id: args.effectId,
    kind: ISSUE_ADD_SESSION_KIND,
    target,
    input:
      args.mode === 'shell'
        ? { sessionId: args.sessionId, shell: true }
        : { sessionId: args.sessionId, ...agent, ...force },
  }
}

/** The issue work that starts nothing: stop, cleanup, ship, the assistant. */
export type IssueWorkAction = 'stop' | 'cleanup' | 'ship' | 'assistant'

const ISSUE_ACTION_KIND: Readonly<Record<IssueWorkAction, string>> = {
  stop: ISSUE_STOP_KIND,
  cleanup: ISSUE_CLEANUP_KIND,
  ship: ISSUE_SHIP_KIND,
  assistant: ISSUE_ASSISTANT_KIND,
}

/** The effect kind answering an agent's question is, every way Podium answers (POD-6415). */
export const SESSION_ANSWER_KIND = 'session.answer'

/**
 * What an answer says, by how it is delivered: `menu` for a live
 * AskUserQuestion menu (`choices`, or `skip`), `interaction` for a durable ask
 * row (`text`, or a typed `answer`). The server checks it against the session's
 * own ask at create.
 */
export type SessionAnswer =
  | {
      via: 'menu'
      interactionId?: string
      choices?: readonly Record<string, unknown>[]
      skip?: true
    }
  | {
      via: 'interaction'
      interactionId: string
      text?: string
      answer?: { kind: string } & Record<string, unknown>
    }

/** An answer to a session's question as its `session.answer` effect record. */
export function sessionAnswerEffect(args: {
  effectId: string
  sessionId: SessionId
  answer: SessionAnswer
}): EffectCreateInput {
  return {
    id: args.effectId,
    kind: SESSION_ANSWER_KIND,
    target: { kind: 'session', id: args.sessionId },
    input: args.answer,
  }
}

/** One of those as its effect record. Only a stop takes an input (`force`). */
export function issueActionEffect(args: {
  effectId: string
  issueId: IssueId
  action: IssueWorkAction
  force?: boolean
}): EffectCreateInput {
  return {
    id: args.effectId,
    kind: ISSUE_ACTION_KIND[args.action],
    target: { kind: 'issue', id: args.issueId },
    input: args.action === 'stop' && args.force === true ? { force: true } : {},
  }
}
