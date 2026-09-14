/**
 * **THE SHARED/PRIVATE SPLIT OF THE ISSUE PROJECTION** — B3 (PDM-135).
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE READING A GREEN TEST AS SAFETY
 * ---------------------------------------------------------------------------
 *
 * This file is a CLASSIFICATION. A green test here is not a feed green: it
 * proves the omit schema, not that any producer parses through it.
 *
 * Enforcement of the shared half is at the producers [PDM-387]:
 * `issueProjectionRows`, `IssueService.projectionChanges`, the live `issue`
 * change specs, `IssuePublisher.issuesChanged` / `issueUpdated`, and the boot
 * reconcile all call `toSharedWire` / `toSharedIssueWire`. The ledger-wrapper
 * half (total over commit/capture/reconcile) is PDM-415's and is a second
 * layer, not a substitute. `IssueProjection` / `IssueWire` themselves still
 * declare the four keys — the owner's client holds them after
 * `joinIssueExecution`. What must not ride the shared arms is the bytes.
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
import { IssueWire } from '../entities/issue'
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

/**
 * The private keys as zod's `.omit()`/`.pick()` take them, derived from the one
 * list.
 *
 * EXPORTED (B4, PDM-136) because the sidecar that carries the private half away
 * — `./issue-execution.ts` — picks with exactly this mask. Two masks built from
 * the same list would still be two places to edit; one mask means the shared
 * payload loses a key and the sidecar gains it in the same edit, which is what
 * makes the pair total by construction rather than by review.
 */
export const ISSUE_PRIVATE_KEY_MASK = Object.fromEntries(
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
export const SharedIssueProjection = IssueProjection.omit(ISSUE_PRIVATE_KEY_MASK)
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

/**
 * **The LEGACY issue wire as a reader who is not its owner may see it**, and the
 * half of this split that PDM-387's brief did not name.
 *
 * THE BRIEF SAID `issueProjection`; THERE ARE TWO DOORS. `IssueWire` carries the
 * same four keys (`entities/issue.ts`: `worktreePath` and `machineId` on
 * `IssueWireCore`, `coordinatorSessionId` and `startedBySession` on
 * `IssueWireTail`), it is a live broadcast arm in BOTH transports
 * (`protocol/messages/feed.ts` `feedChangeArm(z.literal('issue'), IssueWire)`
 * and `messages/sync.ts`'s matching metadata arm), it is reconciled on every
 * issue write, and it is in the bootstrap snapshot tail. Decisively, the feed's
 * read predicate does not distinguish the two kinds —
 * `apps/server/src/feed-visibility.ts` resolves
 * `ref.entity === 'issue' || ref.entity === 'issueProjection'` through ONE arm —
 * so the predicate C4 (PDM-144) widens widens both at once. A sidecar paying for
 * only one of them would close one door of two while every instrument read
 * green, which is the shape the false-green catalogue calls a fix without a
 * mechanism.
 *
 * Derived with the same mask as {@link SharedIssueProjection} rather than a
 * second key list, for the same reason `ISSUE_PRIVATE_KEY_MASK` is exported: the
 * two shared shapes and the sidecar are three views of ONE list.
 */
export const SharedIssueWire = IssueWire.omit(ISSUE_PRIVATE_KEY_MASK)
export type SharedIssueWire = z.infer<typeof SharedIssueWire>

/** Legacy R4 -> shared legacy R4. `.parse()`, never a structural delete, for the
 *  reason {@link toSharedWire} gives. */
export const toSharedIssueWire = (wire: IssueWire): SharedIssueWire =>
  SharedIssueWire.parse(wire)
