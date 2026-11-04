import type { AgentKind, IssueId, MachineId, MutationId, RepoId, SessionId } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import type { PodiumClientApi } from './api'

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

export type TaskSpawnOutcome = 'started' | 'issue-only' | 'failed'

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
 * is assembled. Engine calls this at its action boundary; `draftLaunchEffect`
 * and `createIssueAgent` repeat it as defense in depth for direct callers.
 */
export function assertSpawnPlacement(target: SpawnTarget): void {
  if (target.placement === 'unauthorized') throw new SpawnPlacementError('unauthorized')
  if (target.placement === 'unreachable') throw new SpawnPlacementError('unreachable')
}

export async function createIssueAgent(args: {
  trpc: PodiumClientApi
  sessionId: SessionId
  issueId: IssueId
  mutationId: MutationId
  target: SpawnTarget
  title: string
  description: string
  brief?: string
  parentBranch?: string
  agentKind: AgentKind
  model?: string
  effort?: string
}): Promise<void> {
  assertSpawnPlacement(args.target)
  await args.trpc.issues.create.mutate({
    id: args.issueId,
    startSessionId: args.sessionId,
    repoPath: args.target.repoPath,
    ...(args.target.machineId ? { machineId: args.target.machineId } : {}),
    title: args.title,
    description: args.description,
    ...(args.brief ? { brief: args.brief } : {}),
    ...(args.parentBranch ? { parentBranch: args.parentBranch } : {}),
    defaultAgent: args.agentKind,
    ...(args.model ? { defaultModel: args.model } : {}),
    ...(args.effort ? { defaultEffort: args.effort } : {}),
    startNow: true,
    mutationId: args.mutationId,
  })
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
      ...(args.requestedDriverId !== undefined ? { requestedDriverId: args.requestedDriverId } : {}),
    },
  }
}
