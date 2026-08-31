import { createLogger } from '@podium/logger'
import {
  asMutationId,
  type AgentKind,
  type IssueId,
  type MachineId,
  type MutationId,
  type RepoId,
  type SessionId,
} from '@podium/model'
import type { PodiumClientApi } from './api'

const log = createLogger('client-core:spawn')

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
 * `firstPrompt` rides `sessions.create.initialPrompt` so argv-capable harnesses
 * (claude/codex/grok) get it on the launch command — race-free. resumeAndSend is
 * only the fallback for harnesses that cannot take a launch argv: typing into a
 * fresh Grok PTY does not start a turn (POD-549).
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

const ARGV_PROMPT_HARNESSES: ReadonlySet<AgentKind> = new Set(['claude-code', 'codex', 'grok'])

/**
 * Harnesses whose first prompt is a launch argv token. Mirrors
 * `packages/harness` `capabilities.argvPrompt` without pulling that package into
 * client-core.
 */
export function agentAcceptsArgvPrompt(kind: AgentKind): boolean {
  return ARGV_PROMPT_HARNESSES.has(kind)
}

/**
 * Refuse a placement before any optimistic entity is painted or network request
 * is assembled. Engine calls this at its action boundary; createDraftAgent
 * repeats it as defense in depth for direct callers.
 */
export function assertSpawnPlacement(target: SpawnTarget): void {
  if (target.placement === 'unauthorized') throw new SpawnPlacementError('unauthorized')
  if (target.placement === 'unreachable') throw new SpawnPlacementError('unreachable')
}

export async function createDraftAgent(args: {
  trpc: PodiumClientApi
  sessionId: SessionId
  issueId: IssueId
  mutationId?: MutationId
  target: SpawnTarget
  agentKind: AgentKind
  firstPrompt?: string
  model?: string
  effort?: string
}): Promise<void> {
  assertSpawnPlacement(args.target)
  const text = args.firstPrompt?.trim()
  await args.trpc.sessions.create.mutate({
    sessionId: args.sessionId,
    ...(args.mutationId ? { mutationId: args.mutationId } : {}),
    agentKind: args.agentKind,
    cwd: args.target.path,
    draftIssue: { repoPath: args.target.repoPath, issueId: args.issueId },
    ...(args.target.machineId ? { machineId: args.target.machineId } : {}),
    ...(text ? { initialPrompt: text } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
  })
  // Non-argv harnesses only get a composer draft seed from create; still deliver
  // via resumeAndSend. Argv agents already received the prompt on launch —
  // re-typing it would double-fire.
  if (text && !agentAcceptsArgvPrompt(args.agentKind)) {
    // Best-effort: the session exists either way; a failed first-prompt delivery
    // must not fail the spawn (the user lands in the session and can retype).
    // Still honour ok:false — a swallowed dead-letter looks like a delivered
    // first turn while the agent stays idle (POD-546).
    try {
      const result = await args.trpc.sessions.resumeAndSend.mutate({
        sessionId: args.sessionId,
        text,
        // One launch spans two command procedures for non-argv harnesses. Give
        // the fallback its own stable receipt while staying inside the wire's
        // 128-character mutation-id bound.
        ...(args.mutationId
          ? { mutationId: asMutationId(`${args.mutationId.slice(0, 115)}:first-prompt`) }
          : {}),
      })
      if (
        result !== null &&
        typeof result === 'object' &&
        'ok' in result &&
        (result as { ok: unknown }).ok === false
      ) {
        log.debug('first prompt refused after spawn', {
          sessionId: args.sessionId,
          reason: (result as { reason?: string }).reason,
        })
      }
    } catch {
      // transport blip — session is up; retype from the composer
    }
  }
}

/** Create and start a named task with client-minted issue/session identities.
 * The matching optimistic rows can therefore stay mounted until replica truth
 * replaces them, including the task's first prompt and chat route. */
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
