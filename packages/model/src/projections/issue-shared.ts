/**
 * **THE SHARED/PRIVATE SPLIT OF THE ISSUE PROJECTION** — B3 (PDM-135).
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE READING A GREEN TEST AS SAFETY
 * ---------------------------------------------------------------------------
 *
 * This file is a CLASSIFICATION. It is not, on its own, an enforcement, and
 * nothing here changes what the feed currently broadcasts. `IssueProjection` is
 * still the payload the `issueProjection` change-log entity carries, and it
 * still contains every key named private below. Saying so here rather than only
 * in a receipt, because a reader who meets `SharedIssueProjection` and its
 * passing tests could reasonably conclude the payload had been made safe. It has
 * not. It has been CLASSIFIED, which is the necessary first half.
 *
 * WHY THE SECOND HALF IS NOT HERE. The `issueProjection` payload is
 * PRINCIPAL-INDEPENDENT by construction: `prepareBatch` resolves one
 * `currentValueOf` per row before any principal is considered, and `anchorFor`
 * decides only WHICH rows a principal receives, never what a row says. So there
 * is no per-principal seam in the kernel to filter at, and filtering is the
 * wrong shape anyway — `issue-projection.ts`'s own header prescribes the right
 * one: "If a future field wants to live here, it is almost certainly a D7.3
 * replica-side view or a D7.4 materialized entity instead." The private half
 * belongs on an owner-scoped sidecar entity the replica joins by issue id,
 * exactly as it already joins `issueDep` and `repo`. That crosses into
 * `packages/protocol` and `packages/client-core` and is B4's seam, so it is its
 * own issue, and that issue carries a `blocks` edge to C4.
 *
 * AND DELETING THE KEYS IS NOT THE CHEAP ALTERNATIVE. Absence would take them
 * from the OWNER's client too, which reads `projection.worktreePath` in
 * `client-core/src/replica/issue-view-models.ts` and keys its workspace tabs off
 * it. The sidecar is what pays for the removal.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE LINE IS, AND THE ONE JUDGEMENT CALL IN IT
 * ---------------------------------------------------------------------------
 *
 * B3's spec says: classify title/description/brief/discussion/artifacts as
 * shared; split private prompts, transcripts, approvals, resume identifiers,
 * machine paths and live agent state. Most of that list is not on this
 * projection at all — prompts, transcripts, approvals and live agent state live
 * on the `session`, `conversation` and `pendingInteraction` entities, which
 * PDM-251 made private and which C4 does not widen. What is left on the ISSUE is
 * the four keys below.
 *
 * `branch` and `parentBranch` are SHARED, and that is the judgement call. The
 * spec's fourth behaviour says to sanitise repository identity *without making
 * filesystem metadata globally readable* — a sentence that only does work if the
 * two are different things. They are: a branch names a line of development a
 * shared task legitimately refers to, and it is normally derived from the task's
 * own title, which is shared by definition. An absolute worktree path names a
 * location on one human's machine. Ruled and recorded by the PDM-107
 * coordinator, 2026-09-13. If a branch name is ever found carrying something its
 * task title does not, that is a finding about branch naming, not a reason to
 * reclassify the field.
 */

import { z } from 'zod'
import { IssueProjection } from './issue-projection'

/**
 * The closed set of `IssueProjection` keys that are private execution or
 * machine-local data.
 *
 * A `const` tuple rather than a `Set`, so the TYPE below is derived from these
 * four names and a fifth cannot be added without the type moving with it.
 */
export const ISSUE_PRIVATE_EXECUTION_KEYS = [
  /** An absolute path on one human's machine. The spec's "machine paths". */
  'worktreePath',
  /** WHICH machine. Maps a task to a machine and, under "exactly one human may
   *  execute through Podium on a machine", to a human. */
  'machineId',
  /** A link to a SESSION, which PDM-251 made private. The spec's
   *  "task-to-private-resource links": publishing the id of a private resource
   *  to everyone who can read the task is the same disclosure through a
   *  different door. */
  'coordinatorSessionId',
  /** The same, for the session that started the task. */
  'startedBySession',
] as const

export type IssuePrivateExecutionKey = (typeof ISSUE_PRIVATE_EXECUTION_KEYS)[number]

/**
 * The complement, DERIVED from the projection's own shape rather than retyped.
 *
 * A retyped list here would be the thing catalogue shape 7 names: a second
 * hand-maintained copy of the same assumption, so a key missing from BOTH lists
 * would leave every test green. Deriving it means a new field on
 * `IssueAggregate` lands in `SHARED_ISSUE_KEYS` automatically — which is the
 * safe-by-default direction for a broadcast payload only because
 * `issue-shared.test.ts` asserts the totality out loud and pins the four private
 * names, so a new field that SHOULD be private is a visible decision rather than
 * a silent default.
 */
export const SHARED_ISSUE_KEYS = Object.keys(IssueProjection.shape).filter(
  (key): key is Exclude<keyof IssueProjection & string, IssuePrivateExecutionKey> =>
    !(ISSUE_PRIVATE_EXECUTION_KEYS as readonly string[]).includes(key),
)

/** The private keys as zod's `.omit()` takes them, derived from the one list. */
const privateKeyMask = Object.fromEntries(
  ISSUE_PRIVATE_EXECUTION_KEYS.map((key) => [key, true as const]),
) as { [K in IssuePrivateExecutionKey]: true }

/**
 * **The issue projection as a reader who is not its owner may see it.**
 *
 * Composed by `.omit()` over the canonical R4 — never restated — for the reason
 * `fields/README.md` rule 2 gives: requiredness is declared at R1 where the fact
 * is always true, and a projection that must omit a field omits it, with its own
 * fixtures as the gate. This is that projection and `issue-shared.test.ts` is
 * that gate.
 */
export const SharedIssueProjection = IssueProjection.omit(privateKeyMask)
export type SharedIssueProjection = z.infer<typeof SharedIssueProjection>

/**
 * R4 → shared R4.
 *
 * `.parse()` rather than a structural delete, so the omission is enforced by the
 * schema that DEFINES the shared shape rather than by a second list of keys in a
 * loop body — the same reason `issueDepToProjection` parses instead of casting.
 * A key added to the private list is therefore stripped here with no edit.
 */
export const toSharedWire = (projection: IssueProjection): SharedIssueProjection =>
  SharedIssueProjection.parse(projection)
