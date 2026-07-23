import type { IssueWire, SessionMeta } from '@podium/protocol'

export interface WorkIssue {
  issue: IssueWire
  sessions: SessionMeta[]
}

export interface WorkSection {
  key: string
  title: string
  data: WorkIssue[]
}

const ACTIVE_STAGES = new Set(['planning', 'in_progress', 'review'])

function repoName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Issue-first mobile counterpart of the desktop work sidebar. */
export function buildWorkSections(issues: IssueWire[], sessions: SessionMeta[]): WorkSection[] {
  const liveSessions = sessions.filter(
    (session) => !session.archived && session.agentKind !== 'shell' && session.headless !== true,
  )
  const sessionsByIssue = new Map<string, SessionMeta[]>()
  for (const session of liveSessions) {
    if (!session.issueId) continue
    const group = sessionsByIssue.get(session.issueId) ?? []
    group.push(session)
    sessionsByIssue.set(session.issueId, group)
  }

  const byRepo = new Map<string, WorkIssue[]>()
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt || issue.stage === 'proposed') continue
    const direct = sessionsByIssue.get(issue.id) ?? []
    const included = new Map<string, SessionMeta>()
    for (const session of [...direct, ...(issue.sessions ?? [])]) {
      if (session.archived || session.agentKind === 'shell' || session.headless === true) continue
      included.set(session.sessionId, session)
    }
    const issueSessions = [...included.values()].sort((a, b) =>
      b.lastActiveAt.localeCompare(a.lastActiveAt),
    )
    if (!ACTIVE_STAGES.has(issue.stage) && issueSessions.length === 0) continue
    const group = byRepo.get(issue.repoPath) ?? []
    group.push({ issue, sessions: issueSessions })
    byRepo.set(issue.repoPath, group)
  }

  return [...byRepo.entries()]
    .sort(([a], [b]) => repoName(a).localeCompare(repoName(b)))
    .map(([path, data]) => ({
      key: path,
      title: repoName(path),
      data: data.sort(
        (a, b) =>
          Number(b.issue.pinned) - Number(a.issue.pinned) ||
          b.issue.createdAt.localeCompare(a.issue.createdAt),
      ),
    }))
}
