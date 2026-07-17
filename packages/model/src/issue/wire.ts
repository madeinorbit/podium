import { z } from 'zod'
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
 * So: `sessions: SessionMeta[]` → nothing at all. The client already holds the
 * session world and indexes it by `issueId` locally (D7.3). The intermediate
 * step — carrying `memberSessionIds: SessionId[]` — existed briefly and was
 * deleted at the [POD-796] cutover; see the note above `durableWireFields`.
 *
 * ## Every field of `IssueWire` this projection drops, and where it went
 *
 * | Dropped | Why | Where it lives now |
 * |---|---|---|
 * | `sessions: SessionMeta[]` | D7.1 — embeds another entity's projection | a replica-side join over `sessions.issueId` |
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
 * As of [POD-796] there is no exception: every field above is gone and none came
 * back. See the note above `durableWireFields` for why the last one
 * (`memberSessionIds`) did not survive either.
 */

/**
 * There are NO derived wire fields, and that is the load-bearing property.
 *
 * `memberSessionIds: SessionId[]` lived here until the [POD-796] cutover, as the
 * one deliberate exception — a reverse index over `sessions.issue_id`, O(1) per
 * change rather than O(world), so never a D7.2 breach. It is gone anyway, on the
 * rule this file's own docstring set for it: it "should be deleted rather than
 * maintained" if the replica's local index proved sufficient. POD-795's
 * `indexSessionsByIssue` (client-core/src/replica/issue-views.ts) is that index,
 * it costs the publish path exactly nothing, and it is the edge's one true
 * spelling of membership — the server-maintained copy could only ever disagree
 * with it.
 *
 * The field's last argument for existing was that "the feed must be able to
 * express issue→session membership for a replica that has not yet bootstrapped
 * its sessions". ADR 2 D6 closed it: bootstrap is buffered and installed
 * ATOMICALLY, so a replica that has issues but not sessions is not a state any
 * observer can be in.
 *
 * What the emptiness buys, and why it is worth guarding: with no derived input,
 * `toWire(issue)` is a pure function of the issue's own row. A session change
 * therefore cannot dirty an issue projection — not as an optimization the
 * publish path remembers to apply, but because the data to do otherwise is not
 * reachable from the signature. That is D7.2 made structural instead of
 * observed, and it is what the old `sessions: SessionMeta[]` embedding cost
 * (p50 711ms ×2 per switch at 530-session scale).
 *
 * So: if a future field wants to live here, it is almost certainly a D7.3
 * replica-side view or a D7.4 materialized entity instead. Adding one back
 * re-opens the coupling this whole vertical exists to sever.
 */

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
})
export type IssueProjection = z.infer<typeof IssueProjection>
