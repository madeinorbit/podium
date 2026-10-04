import type { IssueCloseReason } from '@podium/model'

/**
 * Proposal screening (POD-277) — the pure half of the phone's "Screen proposed"
 * card flow: the existing ordered issue mutations and closing tally. The
 * screening queue and reconciliation read the pool through use-inbox-data.
 *
 * Screening is deliberately a snapshot: the deck order is fixed when the flow
 * opens so a broadcast never reshuffles the card being decided. Reconciliation
 * only touches the UNDECIDED tail.
 */

/** What the operator did with a card. `skipped` mutates nothing. */
export type ScreeningOutcome = 'accepted' | 'declined' | 'skipped'

/** The close reason a declined proposal is closed with — mirrors the desktop's
 *  "Cancelled" so both surfaces write the same closure vocabulary. Was the old
 *  `wontfix` spelling until POD-1074 folded it into `cancelled`; rows already
 *  stored under the old word still read back as cancelled. */
export const DECLINE_REASON: IssueCloseReason = 'cancelled'

/** The narrow command seam the flow needs, kept explicit so the ordered
 *  promote/start sequence and the optimistic close are testable without a UI. */
export interface ScreeningCommands {
  promoteIssue: (id: string) => Promise<unknown>
  startIssue: (id: string) => Promise<unknown>
  closeIssue: (id: string, reason?: string) => Promise<unknown>
}

/**
 * Carry out a screening decision against the issue tracker.
 *
 *  - accepted: promote the proposal into the backlog, then start it — the same
 *    two-step the desktop board's "Approve & start" runs, so the issue gets its
 *    worktree, branch, and default agent.
 *  - declined: close it as `cancelled` (the server writes stage `done` +
 *    closedReason together — closing IS done).
 *  - skipped: nothing. The proposal stays proposed and comes back next time.
 *
 * `promote` is skipped when the row has already left the proposed lane, so a
 * retry after a half-applied accept (promote landed, start failed) resumes
 * instead of failing on "issue is not proposed" — and so does an accept of a
 * proposal another client promoted a moment earlier.
 */
export async function applyScreeningDecision(
  commands: ScreeningCommands,
  issue: { id: string; stage: string },
  outcome: ScreeningOutcome,
): Promise<void> {
  if (outcome === 'skipped') return
  if (outcome === 'declined') {
    await commands.closeIssue(issue.id, DECLINE_REASON)
    return
  }
  if (issue.stage === 'proposed') await commands.promoteIssue(issue.id)
  await commands.startIssue(issue.id)
}

/** Tally for the deck's closing summary. */
export function screeningTally(outcomes: Iterable<ScreeningOutcome>): {
  accepted: number
  declined: number
  skipped: number
  total: number
} {
  const tally = { accepted: 0, declined: 0, skipped: 0, total: 0 }
  for (const outcome of outcomes) {
    tally[outcome] += 1
    tally.total += 1
  }
  return tally
}
