import type { AgentKind, IssueId, RepoId, SessionId } from '@podium/model'
import type { PodiumClientApi } from './api'

/** Where a new agent lands: a worktree path + its owning repo (+ machine). */
export interface SpawnTarget {
  path: string
  repoPath: string
  /* Stable project identity used to keep optimistic sidebar rows in the same
   * group as their reconciled server row. */
  repoId?: RepoId
  machineId?: string
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
 * can roll back. `firstPrompt` (command-palette fallback) is delivered via
 * resumeAndSend, which queues until the agent is ready and falls back to a plain
 * send when it's already live.
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

export async function createDraftAgent(args: {
  trpc: PodiumClientApi
  sessionId: SessionId
  issueId: IssueId
  target: SpawnTarget
  agentKind: AgentKind
  firstPrompt?: string
}): Promise<void> {
  if (args.target.placement === 'unauthorized') throw new SpawnPlacementError('unauthorized')
  if (args.target.placement === 'unreachable') throw new SpawnPlacementError('unreachable')
  await args.trpc.sessions.create.mutate({
    sessionId: args.sessionId,
    agentKind: args.agentKind,
    cwd: args.target.path,
    draftIssue: { repoPath: args.target.repoPath, issueId: args.issueId },
    ...(args.target.machineId ? { machineId: args.target.machineId } : {}),
  })
  const text = args.firstPrompt?.trim()
  if (text) {
    // Best-effort: the session exists either way; a failed first-prompt delivery
    // must not fail the spawn (the user lands in the session and can retype).
    await args.trpc.sessions.resumeAndSend
      .mutate({ sessionId: args.sessionId, text })
      .catch(() => {})
  }
}
