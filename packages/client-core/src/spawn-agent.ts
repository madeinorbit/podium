import type { AgentKind, IssueId, RepoId, SessionId, MachineId } from '@podium/model'
import type { RuntimeContractRequest } from '@podium/protocol'
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
  target: SpawnTarget
  agentKind: AgentKind
  firstPrompt?: string
  model?: string
  effort?: string
  /** The per-spawn driver override, forwarded verbatim — see `sessions.create`
   *  in `api.ts`. Absent changes nothing, which is every caller today. */
  runtimeContract?: RuntimeContractRequest
}): Promise<void> {
  assertSpawnPlacement(args.target)
  const text = args.firstPrompt?.trim()
  await args.trpc.sessions.create.mutate({
    sessionId: args.sessionId,
    agentKind: args.agentKind,
    cwd: args.target.path,
    draftIssue: { repoPath: args.target.repoPath, issueId: args.issueId },
    ...(args.target.machineId ? { machineId: args.target.machineId } : {}),
    ...(text ? { initialPrompt: text } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.runtimeContract !== undefined ? { runtimeContract: args.runtimeContract } : {}),
  })
}
