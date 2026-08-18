import type { IssueWire } from '@podium/model'

export type AgentLaunchProcedure = 'addSession' | 'start'

/**
 * Choose the server command that can put another agent on an issue.
 *
 * A branch survives when an issue's worktree is freed. That issue must go back
 * through `start`, which reattaches the preserved branch before spawning; only
 * a live worktree can accept `addSession` directly.
 */
export function agentLaunchProcedure(
  issue: Pick<IssueWire, 'branch' | 'worktreePath'>,
): AgentLaunchProcedure {
  return issue.worktreePath ? 'addSession' : 'start'
}
