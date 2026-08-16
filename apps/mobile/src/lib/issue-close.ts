import {
  blockingCloseConcerns,
  type IssueCloseConcern,
  issueCloseConcerns,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/model'

/**
 * THE PHONE'S HALF OF THE CLOSE GUARD [POD-1129] — membership, and nothing else.
 *
 * The facts themselves are `issueCloseConcerns` in `@podium/client-core`, shared
 * verbatim with the desktop. All that is platform-specific is which sessions
 * belong to the issue: the desktop resolves `memberSessionIds` against its
 * store, the phone matches `session.issueId` against the roster it already
 * holds. Archived rows are the derivation's business, not this function's.
 *
 * Only BLOCKERS come back, because on the phone this decides whether to
 * interrupt at all. A press with nothing at stake closes on the press — the
 * guard exists to name a cost, and a sheet that rises to report no cost taxes
 * the most ordinary action on the surface where taps are dearest. Every concern
 * the derivation raises is blocking today; `blockingCloseConcerns` is the seam
 * that keeps that an assertion rather than an assumption.
 */
export function issueCloseBlockers(
  issue: IssueWire,
  sessions: readonly SessionMeta[],
): IssueCloseConcern[] {
  return blockingCloseConcerns(
    issueCloseConcerns(
      issue,
      sessions.filter((session) => session.issueId === issue.id),
    ),
  )
}
