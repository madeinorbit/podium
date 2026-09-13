/**
 * **THE OWNER-SCOPED EXECUTION SIDECAR** — B4 (PDM-136), carrying B3's (PDM-135)
 * classification off the broadcast.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * `issue-shared.ts` named the four keys of `IssueProjection` that are private
 * execution or machine-local data, and said in its own header that naming them
 * was the necessary FIRST half: the payload still carried them, and there is no
 * per-principal seam in the sync kernel to filter a payload at —
 * `prepareBatch` resolves one `currentValueOf` per row before any principal is
 * considered, and `anchorFor` decides only WHICH rows a principal receives,
 * never what a row says.
 *
 * So the private half moves to a row of its OWN, with its OWN audience. This is
 * the second half. The broadcast issue payloads carry the shared keys and
 * nothing else; this entity carries the private keys to the issue's owner alone;
 * and the replica joins the two by issue id, exactly as it already joins
 * `issueDep` and `repo`. `issue-projection.ts`'s own header prescribes this
 * shape in so many words: "If a future field wants to live here, it is almost
 * certainly a D7.3 replica-side view or a D7.4 materialized entity instead."
 *
 * ---------------------------------------------------------------------------
 * WHY A SIDECAR AND NOT A DELETION
 * ---------------------------------------------------------------------------
 *
 * Absence is a regression, not a free win. `client-core/replica/issue-view-models.ts`
 * reads `worktreePath` and the workspace tabs key off it; `viewmodels/mission.ts`
 * and `viewmodels/slices/worklist/rows.ts` build the started-by tree from
 * `startedBySession`; `viewmodels/slices/terminal.ts` elevates the coordinator
 * session from `coordinatorSessionId`. Dropping the keys from the broadcast
 * drops them from the OWNER's own client too, and every one of those surfaces is
 * the owner looking at their own task. The sidecar is what PAYS for the removal:
 * the owner still receives the facts, through a row nobody else is in the
 * audience of.
 *
 * ---------------------------------------------------------------------------
 * WHY ITS AUDIENCE IS THE OWNER AND NOT THE ISSUE'S
 * ---------------------------------------------------------------------------
 *
 * This is the whole point and it is one line in `apps/server/src/feed-visibility.ts`.
 * C4 (PDM-144) replaces the issue read predicate with the active-member class
 * policy. A sidecar whose `mayRead` arm consulted that same predicate would
 * widen at exactly the moment the issue does, and would have bought nothing. Its
 * arm therefore resolves the OWNER of the issue and compares — no grant term, no
 * audience term, no call into `mayReadIssueFromSnapshot`.
 */

import { z } from 'zod'
import { IssueProjection } from './issue-projection'
import { ISSUE_PRIVATE_KEY_MASK, type IssuePrivateExecutionKey } from './issue-shared'

/**
 * **R4 — the private execution half of one issue, as its owner may see it.**
 *
 * `.pick()` over the canonical projection using the SAME mask
 * `SharedIssueProjection` omits with, so the two halves are derived from one
 * list and cannot drift: a fifth name added to `ISSUE_PRIVATE_EXECUTION_KEYS`
 * leaves the shared payload and arrives here in the same edit, with no second
 * place to remember. A retyped field list here would be catalogue shape 7 — a
 * second hand-maintained copy of the assumption under test, where a key missing
 * from BOTH lists leaves every test green.
 *
 * `issueId` rather than `id`: the row's identity IS the issue's, and spelling it
 * `id` would let a reader mistake this for an entity with a life of its own.
 * `replica/kernel/kinds.ts` carries the matching `rowKey` arm.
 */
export const IssueExecutionProjection = z.object({
  /** The issue this is the private half OF. The row's own key. */
  issueId: IssueProjection.shape.id,
  ...IssueProjection.pick(ISSUE_PRIVATE_KEY_MASK).shape,
})
export type IssueExecutionProjection = z.infer<typeof IssueExecutionProjection>

/**
 * R4 → the sidecar row.
 *
 * `.parse()` rather than a hand-written per-key copy, for the reason
 * `toSharedWire` gives: the omission and the extraction are then both properties
 * of one schema derived from one list, and a key added to the private list is
 * carried here with no edit.
 */
export const toExecutionWire = (projection: IssueProjection): IssueExecutionProjection =>
  IssueExecutionProjection.parse({ ...projection, issueId: projection.id })

/**
 * **THE JOIN** — the replica's side of the split, and the only place the two
 * halves are put back together.
 *
 * Written here, beside the split, rather than in the client: a client-side
 * re-assembly is a second statement of which keys are private, and the day the
 * two disagree the payload grows a key nobody notices. Spreading the sidecar
 * over the shared row means the key list is `IssueExecutionProjection`'s and
 * therefore `ISSUE_PRIVATE_EXECUTION_KEYS`'s, once.
 *
 * `execution` absent is the NORMAL case for a reader who is not the owner, and
 * it must not be an error: the shared row is a complete, renderable task. What a
 * non-owner gets is the shared half with the private keys simply unset, which is
 * the same state an issue that was never started presents — which is why every
 * existing reader of these keys already handles absence.
 */
export function joinIssueExecution<T extends object>(
  shared: T,
  execution: IssueExecutionProjection | undefined,
): T & Partial<Pick<IssueProjection, IssuePrivateExecutionKey>> {
  if (execution === undefined) return shared
  const { issueId: _issueId, ...privateHalf } = execution
  return { ...shared, ...privateHalf }
}
