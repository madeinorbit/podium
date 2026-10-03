/** Pure legacy route oracle, also usable by the read-only operator replay. */
import { type SessionValueInput, sessionValues } from '@podium/client-core/session-values'
import { type PodiumTarget, parseIssueRef, parseSessionRef } from '@podium/protocol'

export interface LinkIssueLike {
  id: string
  prefix?: string
  seq?: number
  displayRef?: string
}
export interface LinkSessionLike extends SessionValueInput {
  sessionId: string
}

export function mobilePodiumRoute(
  target: PodiumTarget,
  context: { issues: readonly LinkIssueLike[]; sessions: readonly LinkSessionLike[] },
): string | null {
  if (target.kind === 'issue') {
    if (target.search || target.hash) return null
    const issue = findLinkedIssue(target.issue, context.issues)
    return issue ? `/issue/${encodeURIComponent(issue.id)}` : null
  }
  if (target.kind === 'session') {
    if (target.search || target.hash) return null
    const session = findLinkedSession(target.session, context.sessions)
    return session ? `/session/${encodeURIComponent(session.sessionId)}` : null
  }
  return null
}

export function findLinkedIssue(
  identifier: string,
  issues: readonly LinkIssueLike[],
): LinkIssueLike | undefined {
  const trimmed = identifier.trim()
  const direct = issues.find((issue) => issue.id === trimmed)
  if (direct) return direct
  const byDisplay = issues.find((issue) => issue.displayRef === trimmed)
  if (byDisplay) return byDisplay
  const ref = parseIssueRef(trimmed)
  return ref
    ? issues.find((issue) => issue.prefix === ref.prefix && issue.seq === ref.seq)
    : undefined
}

export function findLinkedSession(
  identifier: string,
  sessions: readonly LinkSessionLike[],
): LinkSessionLike | undefined {
  const trimmed = identifier.trim()
  const direct = sessions.find((session) => session.sessionId === trimmed)
  if (direct) return direct
  return parseSessionRef(trimmed)
    ? sessions.find((session) => sessionValues(session).displayRef === trimmed)
    : undefined
}
