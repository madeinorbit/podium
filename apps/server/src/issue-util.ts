import {
  ISSUE_STAGES,
  type IssueSessionSummary,
  type IssueStage,
  type SessionMeta,
} from '@podium/protocol'

export function slugifyBranch(seq: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug ? `issue/${seq}-${slug}` : `issue/${seq}`
}

export function isMemberCwd(issueWorktree: string | null, cwd: string): boolean {
  if (!issueWorktree) return false
  return cwd === issueWorktree || cwd.startsWith(`${issueWorktree}/`)
}

/** Sessions belonging to an issue. Precedence (issue-as-workspace): a session
 *  with an EXPLICIT issueId belongs to that issue only; sessions without one
 *  fall back to cwd containment in the issue's worktree. */
export function sessionsForIssue(
  worktreePath: string | null,
  sessions: SessionMeta[],
  issueId?: string,
): SessionMeta[] {
  return sessions.filter((s) =>
    s.issueId ? s.issueId === issueId : isMemberCwd(worktreePath, s.cwd),
  )
}

export function summarizeSessions(sessions: SessionMeta[]): IssueSessionSummary {
  const byPhase: Record<string, number> = {}
  for (const s of sessions) {
    const key = s.agentState?.phase ?? 'shell'
    byPhase[key] = (byPhase[key] ?? 0) + 1
  }
  return { total: sessions.length, byPhase }
}

export function stageIndex(stage: IssueStage): number {
  return ISSUE_STAGES.indexOf(stage)
}
