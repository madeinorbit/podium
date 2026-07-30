import { asIssueId, type IssueId, type IssueWire } from '@podium/model'

/**
 * Proposal screening (POD-277) — the pure half of the phone's "Screen proposed"
 * card flow: which proposals enter the deck, in what order, how the deck
 * survives live board changes underneath the operator's thumb, and which issue
 * mutations each outcome performs.
 *
 * Screening is deliberately a snapshot: the deck order is fixed when the flow
 * opens so a broadcast never reshuffles the card being decided. Reconciliation
 * (below) only touches the UNDECIDED tail.
 */

/** What the operator did with a card. `skipped` mutates nothing. */
export type ScreeningOutcome = 'accepted' | 'declined' | 'skipped'

/** The close reason a declined proposal is closed with — mirrors the desktop's
 *  "Close (wontfix)" so both surfaces write the same closure vocabulary. */
export const DECLINE_REASON = 'wontfix'

/** The narrow issue-mutation seam the flow needs (the mobile tRPC client
 *  satisfies it structurally); kept explicit so the outcomes are testable
 *  without a transport. */
export interface ScreeningApi {
  issues: {
    promote: { mutate(input: { id: string }): Promise<unknown> }
    start: { mutate(input: { id: string }): Promise<unknown> }
    close: { mutate(input: { id: string; reason?: string }): Promise<unknown> }
  }
}

/** Is this issue a proposal the operator can still screen? */
function isScreenable(issue: IssueWire): boolean {
  return (
    issue.stage === 'proposed' &&
    !issue.archived &&
    !issue.deletedAt &&
    !issue.draft &&
    issue.audience !== 'agent'
  )
}

/**
 * Ordered screening deck: the proposals whose ancestors are all approved, most
 * urgent first.
 *
 * A proposal nested under another proposal is left out on purpose — the whole
 * proposal subtree is inert until its ROOT is accepted [spec:SP-6144], and the
 * server refuses to start work under an unapproved ancestor, so offering the
 * child as a card would offer a decision that cannot be carried out.
 *
 * Order mirrors the Tasks list (priority ascending, newest first) so the deck
 * and the board agree on what "next" means.
 */
export function buildScreeningQueue(issues: IssueWire[]): IssueWire[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const underProposal = (issue: IssueWire): boolean => {
    const seen = new Set<string>([issue.id])
    let parentId = issue.parentId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) return false
      if (parent.stage === 'proposed') return true
      parentId = parent.parentId
    }
    return false
  }
  return issues
    .filter((issue) => isScreenable(issue) && !underProposal(issue))
    .sort((a, b) => a.priority - b.priority || b.seq - a.seq)
}

/**
 * Fold a fresh board into an open deck without moving the ground under the
 * operator: everything already decided (`order` before `index`) stays put, the
 * undecided tail drops cards that are no longer screenable (someone promoted or
 * closed them elsewhere), and proposals that appeared since the flow opened are
 * appended at the end rather than jumped ahead of the current card.
 */
export function reconcileScreeningOrder(
  order: IssueId[],
  index: number,
  issues: IssueWire[],
): { order: IssueId[]; index: number } {
  const queue = buildScreeningQueue(issues)
  const screenable = new Set(queue.map((issue) => issue.id))
  const decided = order.slice(0, index)
  const seen = new Set(order)
  const tail = order.slice(index).filter((id) => screenable.has(id))
  const arrivals = queue.map((issue) => issue.id).filter((id) => !seen.has(id))
  return { order: [...decided, ...tail, ...arrivals], index: decided.length }
}

/**
 * Carry out a screening decision against the issue tracker.
 *
 *  - accepted: promote the proposal into the backlog, then start it — the same
 *    two-step the desktop board's "Approve & start" runs, so the issue gets its
 *    worktree, branch, and default agent.
 *  - declined: close it as `wontfix` (the server writes stage `done` +
 *    closedReason together — closing IS done).
 *  - skipped: nothing. The proposal stays proposed and comes back next time.
 *
 * `promote` is skipped when the row has already left the proposed lane, so a
 * retry after a half-applied accept (promote landed, start failed) resumes
 * instead of failing on "issue is not proposed" — and so does an accept of a
 * proposal another client promoted a moment earlier.
 */
export async function applyScreeningDecision(
  api: ScreeningApi,
  issue: { id: string; stage: string },
  outcome: ScreeningOutcome,
): Promise<void> {
  if (outcome === 'skipped') return
  if (outcome === 'declined') {
    await api.issues.close.mutate({ id: issue.id, reason: DECLINE_REASON })
    return
  }
  if (issue.stage === 'proposed') await api.issues.promote.mutate({ id: issue.id })
  await api.issues.start.mutate({ id: issue.id })
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
