import type { AgentKind } from '@podium/protocol'
import type { PodiumClientApi } from './api'

/** Where a new agent lands: a worktree path + its owning repo (+ machine). */
export interface SpawnTarget {
  path: string
  repoPath: string
  machineId?: string
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
export async function createDraftAgent(args: {
  trpc: PodiumClientApi
  sessionId: string
  issueId: string
  target: SpawnTarget
  agentKind: AgentKind
  firstPrompt?: string
}): Promise<void> {
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
