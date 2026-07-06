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

/** Send-time mail nudge target (issue #103). Over the issue's member sessions:
 *  - exactly one live agent session AND it is idle → immediate 'send' (sendText);
 *  - otherwise any live agent sessions → most recently active one, 'queue'
 *    (sendTextWhenReady / durable outbox);
 *  - none → null (mail waits for prime / the stop-hook).
 *  Shells never get nudged. */
export function selectMailNudgeSession(
  sessions: SessionMeta[],
): { sessionId: string; mode: 'send' | 'queue' } | null {
  const live = sessions.filter((s) => s.agentKind !== 'shell' && s.status === 'live')
  if (live.length === 0) return null
  if (live.length === 1 && live[0]!.agentState?.phase === 'idle') {
    return { sessionId: live[0]!.sessionId, mode: 'send' }
  }
  const target = [...live].sort((a, b) =>
    (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''),
  )[0]!
  return { sessionId: target.sessionId, mode: 'queue' }
}

export function stageIndex(stage: IssueStage): number {
  return ISSUE_STAGES.indexOf(stage)
}
