import {
  attentionSummary,
  groupSessions,
  relativeTime,
  withoutShells,
  type AttentionGroup,
} from '@podium/client-core/focus'
import type { IssueWire, SessionMeta } from '@podium/protocol'

export interface FocusCardViewModel {
  sessionId: string
  title: string
  subtitle: string
  issueLabel: string | null
  summary: string | null
  group: AttentionGroup
}

export interface BuildFocusCardsInput {
  sessions: SessionMeta[]
  issues: IssueWire[]
  now?: number
}

function titleForSession(session: SessionMeta): string {
  const title = session.title?.trim()
  if (title) return title
  const cwdName = session.cwd.split('/').filter(Boolean).pop()
  return cwdName || session.agentKind
}

function issueLabel(issue: IssueWire | undefined): string | null {
  if (!issue) return null
  return '#' + issue.seq + ' ' + issue.title
}

export function buildFocusCards({ sessions, issues, now = Date.now() }: BuildFocusCardsInput): FocusCardViewModel[] {
  const groups = groupSessions(withoutShells(sessions))
  const queue = [
    ...groups.needsYou.map((session) => ({ session, group: 'needsYou' as const })),
    ...groups.idle.map((session) => ({ session, group: 'idle' as const })),
    ...groups.working.map((session) => ({ session, group: 'working' as const })),
  ]
  return queue.map(({ session, group }) => {
    const issue = session.issueId ? issues.find((candidate) => candidate.id === session.issueId) : undefined
    return {
      sessionId: session.sessionId,
      title: titleForSession(session),
      subtitle: session.agentKind + ' - ' + session.status + ' - ' + relativeTime(session.lastActiveAt, now),
      issueLabel: issueLabel(issue),
      summary: attentionSummary(session),
      group,
    }
  })
}
