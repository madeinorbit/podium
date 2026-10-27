import { type IssueStage, isFinished, issueLanding, issueStatusLabel } from '@podium/model/browser'
import type { SessionView } from '../session-values'

/**
 * How a session's issue ended, when closing the issue is what stopped the
 * session (POD-2151). Read from the issue row and the session's own stop
 * stamp, never from agent text: a landing usually stops the agent mid-turn,
 * so its transcript cannot be trusted to say what happened.
 */
export type SessionIssueOutcome =
  | { kind: 'landed'; at: string; branch: string | null; sha: string | null }
  | { kind: 'closed'; at: string | null; reason: string }

export interface OutcomeIssueFacts {
  readonly stage: string
  readonly closedReason?: string | null
  readonly closedAt?: string | null
  readonly landedAt?: string | null
  readonly landedSha?: string | null
  readonly parentBranch?: string | null
  readonly branch?: string | null
  readonly gitState?: unknown
}

export function sessionIssueOutcome(
  session: Pick<SessionView, 'status' | 'stopReason' | 'stoppedAt'> | undefined,
  issue: OutcomeIssueFacts | undefined,
): SessionIssueOutcome | null {
  // 'parent' is also an operator's stop; only a closed issue makes it this one.
  if (!session || !issue || session.stopReason !== 'parent') return null
  if (session.status !== 'hibernated' && session.status !== 'exited') return null
  if (!isFinished(issue)) return null
  // A session parked before its issue closed did not end with it.
  const closedMs = Date.parse(issue.closedAt ?? issue.landedAt ?? '')
  const stoppedMs = Date.parse(session.stoppedAt ?? '')
  if (stoppedMs < closedMs) return null
  // Named reads, never a spread: a pool model's fields are prototype getters.
  const facts = {
    stage: issue.stage as IssueStage,
    closedReason: issue.closedReason,
    landedAt: issue.landedAt,
    landedSha: issue.landedSha,
    parentBranch: issue.parentBranch,
    branch: issue.branch,
    gitState: issue.gitState,
  }
  const landing = issueLanding(facts)
  if (landing) return { kind: 'landed', ...landing }
  return {
    kind: 'closed',
    at: issue.closedAt ?? null,
    reason: issueStatusLabel(facts).toLowerCase(),
  }
}
