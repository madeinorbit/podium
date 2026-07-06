import type { AgentKind } from '@podium/protocol'
import type { Trpc } from './trpc'

/** Where a new agent lands: a worktree path + its owning repo (+ machine). */
export interface SpawnTarget {
  path: string
  repoPath: string
  machineId?: string
}

/**
 * Spawn `agentKind` into `target` inside a fresh draft issue — the ONE
 * "New <Agent> in <Repo>" spawn path, shared by the unified sidebar button and
 * the command palette's free-text fallback. `firstPrompt` (palette fallback) is
 * delivered via resumeAndSend, which queues until the agent is ready and falls
 * back to a plain send when it's already live.
 */
export async function spawnDraftAgent(args: {
  trpc: Trpc
  target: SpawnTarget
  agentKind: AgentKind
  firstPrompt?: string
}): Promise<string> {
  const { trpc, target, agentKind, firstPrompt } = args
  const { sessionId } = await trpc.sessions.create.mutate({
    agentKind,
    cwd: target.path,
    draftIssue: { repoPath: target.repoPath },
    ...(target.machineId ? { machineId: target.machineId } : {}),
  })
  const text = firstPrompt?.trim()
  if (text) {
    // Best-effort: the session exists either way; a failed first-prompt delivery
    // must not fail the spawn (the user lands in the session and can retype).
    await trpc.sessions.resumeAndSend.mutate({ sessionId, text }).catch(() => {})
  }
  return sessionId
}
