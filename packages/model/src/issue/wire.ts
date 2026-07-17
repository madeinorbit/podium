import { z } from 'zod'
import { SessionId } from '../ids'
import { wireShape } from '../shape'
import { issueDurableShape } from './fields'

/**
 * **R4 — the Issue wire / read projection** [ADR 4 D2], and the NORMALIZED
 * successor to `@podium/protocol`'s `IssueWire`.
 *
 * Named `IssueProjection` rather than `IssueWire2`/`IssueWireV2` on purpose: the
 * two coexist until the POD-796 cutover deletes the old one, and a version suffix
 * would outlive the transition it describes. `IssueProjection` says what it is.
 *
 * ## Why this is not just "IssueWire minus a field"
 *
 * `IssueWire` embeds `sessions: SessionMeta[]` — a derived array of ANOTHER
 * entity's full projection. That is the canonical ADR 4 D7.1 non-compliance, and
 * it is not a cosmetic one: because every issue's payload contains every member
 * session's payload, a one-field change to a single session forces an O(world)
 * rebuild of every issue's wire payload (POD-701/POD-772 entry 1 measured p50
 * 711ms ×2 per switch at 530-session scale). D7.1 makes that shape
 * unrepresentable:
 *
 *   > A replicated entity references other entities by **branded id only**. An R4
 *   > wire/read projection MUST NOT embed another entity's projection.
 *
 * So: `sessions: SessionMeta[]` → `memberSessionIds: SessionId[]`. The client
 * already holds the session world; it joins locally (D7.3).
 *
 * ## Every field of `IssueWire` this projection drops, and where it went
 *
 * | Dropped | Why | Where it lives now |
 * |---|---|---|
 * | `sessions: SessionMeta[]` | D7.1 — embeds another entity's projection | `memberSessionIds` + a replica-side join |
 * | `sessionSummary` | rollup OVER sessions: a session's phase change would recompute the issue (D7.2) | replica-side view (D7.3) |
 * | `unread` | derived from member sessions' `lastActiveAt` vs `readAt` — same cross-entity dependency | replica-side view over `readAt` (which IS durable and IS here) |
 * | `ready`, `blocked`, `deferred` | `blocked` reads OTHER issues' stages through `issue_deps`; closing issue B would recompute issue A | replica-side view (D7.3) |
 * | `childCount`, `childDoneCount` | tree rollups over other issues — D7.3 names "issue trees" as the worked example | replica-side view (D7.3) |
 * | `commentCount` | rollup over `issue_comments` | replica-side view, or a D7.4 materialized entity if the client never holds comments |
 * | `displayRef`, `prefix` | derived from (repo prefix, seq); a repo's prefix change would recompute every issue in the repo | replica-side view over `seq` + the repo entity |
 * | `labels`, `deps`, `dependents`, `comments` | relations, not columns — see `aggregate.ts` | own entities (D7.1) or replica-side (D7.3); POD-795/796 |
 * | `viaHub`, `upstreamStale`, `pendingSync` | provenance is not entity payload (D3.8) | `ReplicatedEnvelope<T>` (POD-304) |
 *
 * The through-line is D7.2: **a change to entity X may trigger recomputation only
 * of projections of X.** Every field above is a function of something other than
 * this issue's own durable row, so computing it here would put cross-entity work
 * on the write/publish path — the exact defect POD-736's harness gates. Pushing
 * them replica-side is not a feature regression: the client holds the world, so
 * the join is local and incremental, keyed by `(entityId, revision)` (D7.3).
 *
 * The one deliberate exception is `memberSessionIds` — see below.
 */

/**
 * Derived wire fields: not durable, not aggregate members, computed at
 * projection time from an explicitly-passed input (see `IssueDerivedInputs` in
 * `./mapping.ts`) so the dependency is visible in the type rather than reached
 * for through a service handle.
 */
export const issueDerivedWireFields = {
  /**
   * The sessions working this issue, BY ID ONLY [ADR 4 D7.1].
   *
   * A reference, never an embedding: this is the field that replaces
   * `IssueWire.sessions: SessionMeta[]` and it is the whole point of the
   * normalization.
   *
   * Honest caveat for POD-795/POD-796: membership is stored on the SESSION side
   * (`sessions.issue_id`), so this array is itself a reverse index — a session
   * re-homing to another issue dirties two issue projections. That is O(1) per
   * change, not O(world), so it does not breach D7.2's "no fan-out work
   * proportional to the number of entities". But it is strictly WEAKER than
   * deriving membership replica-side by indexing sessions on `issueId`, which
   * costs the publish path nothing at all and which the replica can do because it
   * already holds every session. If POD-795 finds the local index sufficient,
   * this field should be deleted rather than maintained; it is here because the
   * feed must be able to express issue→session membership for a replica that has
   * not yet bootstrapped its sessions.
   */
  memberSessionIds: z.array(SessionId),
} as const

const durableWireFields = wireShape(issueDurableShape)

export const IssueProjection = z.object({
  ...durableWireFields,

  // ---- Forward-compatibility tolerance (wire-only) ----
  //
  // Derived from the field group, NOT restated: `durableWireFields.color` already
  // carries the type, brand and optionality; `.catch()` only adds the tolerance.
  // The tolerance belongs on R4 and NOT on R1/R3 by design — parsing a payload
  // from a peer that may be NEWER than us is a wire concern. A newer peer that
  // adds an 11th colour slot must degrade to "no colour" on this client rather
  // than fail the whole issue's parse; the durable aggregate, by contrast, should
  // never silently swallow a value it does not understand.
  color: durableWireFields.color.catch(undefined),
  humanQuestionOptions: durableWireFields.humanQuestionOptions.catch(undefined),

  ...issueDerivedWireFields,
})
export type IssueProjection = z.infer<typeof IssueProjection>
