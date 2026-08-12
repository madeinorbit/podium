import type { IssueRehomeTarget, IssueWire, SessionId, IssueId, MachineId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'

/**
 * Narrow issue capability used only by the L3 issue/session application
 * orchestrator. SessionLifecycle never stores this port: each atomic workflow
 * receives it explicitly from the orchestrator that owns the cross-feature
 * boundary.
 */
export interface SessionIssueWorkflowPort {
  ensureWorktree(
    issueId: IssueId,
    machineId?: MachineId,
  ): Promise<{ ok: boolean; output: string; worktreePath: string | null; issue: IssueWire }>
  freeWorktreeKeepBranch(
    issueId: IssueId,
    principal: CommandPrincipal,
    options: { force: boolean },
  ): Promise<{ ok: boolean; output: string; worktreeFreed: boolean }>
  rehome(issueId: IssueId, where: IssueRehomeTarget): IssueWire | null
  recordSessionGitActivity?(
    sessionId: SessionId,
    input: { commits?: string[]; touched?: string[] },
  ): void
}
