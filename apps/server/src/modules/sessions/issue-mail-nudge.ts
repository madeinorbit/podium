import type { IssueId, SessionId, SessionMeta } from '@podium/model'
import { selectMailNudgeSession } from '../../issue-util'

export interface IssueMailNudgeEvent {
  issueId: IssueId
  seq: number
}

export interface IssueMailNudgePorts {
  issueMeta(issueId: IssueId): Promise<
    | {
        id: IssueId
        worktreePath: string | null
        coordinatorSessionId?: SessionId | null
      }
    | undefined
  >
  sessionsForIssue(worktreePath: string | null, issueId: IssueId): Promise<SessionMeta[]>
  receiptSend(via: 'now' | 'queue', input: { sessionId: SessionId; text: string }): Promise<unknown>
}

/** Legacy issue-mail's send-time nudge. Resolve both membership and coordinator
 * from the canonical issue id at delivery time: passing only a worktree path
 * excluded every explicitly issue-bound session, while the old recency-only
 * choice bypassed the issue's designated coordinator. */
export async function nudgeIssueMail(
  ports: IssueMailNudgePorts,
  event: IssueMailNudgeEvent,
): Promise<void> {
  const issue = await ports.issueMeta(event.issueId)
  if (!issue) return
  const members = await ports.sessionsForIssue(issue.worktreePath, issue.id)
  const target = selectMailNudgeSession(members, issue.coordinatorSessionId)
  if (!target) return
  const text = `You have mail on issue #${event.seq}: run 'podium issue mail inbox' (claim with 'podium issue mail claim <id>' only if you will act on it).`
  await ports.receiptSend(target.mode === 'send' ? 'now' : 'queue', {
    sessionId: target.sessionId,
    text,
  })
}
