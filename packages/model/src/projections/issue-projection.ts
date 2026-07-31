/**
 * **R4 — the Issue wire / read projection** [ADR 4 D2], and the NORMALIZED
 * successor to `../entities/issue.ts`'s `IssueWire`.
 *
 * PORTED FROM MAIN at the POD-1246 catch-up (main's `issue/wire.ts`), and this
 * is the one ported file whose CONTENT is not main's. Main derived it from main's
 * `issueDurableShape`; here it is derived from `IssueAggregate` — THIS tree's
 * canonical R1, the collapse of POD-364's seventeen issue representations. Both
 * branches state the same rule (R4 = the durable shape under the wire
 * nullability convention, plus wire-only tolerance); taking main's field list
 * instead would have imported a second issue vocabulary beside the one
 * `fields/issue.ts` exists to be, which is the drift both branches are deleting.
 *
 * WHAT THAT MEANS FOR CONSUMERS: main's server-side producers and its client-side
 * readers of `IssueProjection` were written against main's key spelling, and this
 * tree's vocabulary renamed several of those keys ON COMPOSITION (`blockedBy` →
 * `blockedByNotes`, `origin` → `intentOrigin`, `draft` → `isDraftVessel`) and
 * nested the needs-human pair under `asked`. Those consumers are in the merge's
 * remaining issues-vertical tranche and must be reconciled against THIS shape,
 * not against main's. That is a rename sweep, not a modelling question.
 *
 * Named `IssueProjection` rather than `IssueWire2`/`IssueWireV2` on purpose: the
 * two coexist until the POD-796 cutover deletes the old one, and a version suffix
 * would outlive the transition it describes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST "IssueWire MINUS A FIELD"
 * ---------------------------------------------------------------------------
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
 * session world and indexes it by `issueId` locally (D7.3). The intermediate step
 * — carrying `memberSessionIds: SessionId[]` — existed briefly on main and was
 * deleted at the POD-796 cutover.
 *
 * Every derived field `IssueWire` carries and this does not — `sessionSummary`,
 * `unread`, `ready`, `blocked`, `deferred`, `childCount`, `childDoneCount`,
 * `commentCount`, `displayRef`, `prefix`, `repoPath`, `gitState` — is already
 * named ONCE in this tree, on `IssueDerived` (`../fields/issue.ts`), precisely so
 * it can be kept OUT of R1 and therefore out of here. The through-line is D7.2:
 * **a change to entity X may trigger recomputation only of projections of X.**
 * Each of those is a function of something other than this issue's own durable
 * row, so computing it here would put cross-entity work on the fan-out path.
 * `blocked` in particular reads OTHER issues' stages through `issue_deps`; it
 * moves replica-side, over the `IssueDep` edges the feed now carries
 * (`../entities/issue-dep.ts`), and `prefix` over the `Repo` rows it now carries
 * (`../entities/repo.ts`). Those two entities exist BECAUSE this projection does
 * not carry these fields.
 *
 * THERE ARE NO DERIVED WIRE FIELDS, and that is the load-bearing property: with
 * no derived input, `toWire(issue)` is a pure function of the issue's own row, so
 * a session change cannot dirty an issue projection — not as an optimization the
 * publish path remembers to apply, but because the data to do otherwise is not
 * reachable from the signature. If a future field wants to live here, it is
 * almost certainly a D7.3 replica-side view or a D7.4 materialized entity
 * instead.
 */

import { z } from 'zod'
import { IssueAggregate } from '../aggregates/issue'
import { dropNullValues, wireShape } from '../shape'

/** The canonical R1 under the durable→wire nullability convention (`../shape.ts`):
 *  every `T | null` durable field becomes absent-when-unset on the wire. Derived,
 *  never restated — a retyped key list here would be the 18th issue
 *  representation rather than the collapse of the other 17 (ADR 4 D3.3). */
const durableWireFields = wireShape(IssueAggregate.shape)

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
  //
  // Main tolerated a second field here, `humanQuestionOptions`. It has no
  // counterpart to tolerate: this tree nests the needs-human pair as
  // `asked: { question, options, at, by, attribution }` (`fields/issue.ts`,
  // NeedsHuman) precisely so "when" cannot arrive without "who", and `options` is
  // a plain `z.array(z.string()).optional()` inside it with no closed vocabulary
  // a newer peer could widen. The tolerance existed for main's enum-typed slot
  // list; it would be decoration here.
  color: durableWireFields.color.catch(undefined),
})
export type IssueProjection = z.infer<typeof IssueProjection>

/**
 * **R1 → R4** — the one documented mapping onto this projection [ADR 4 D3.4,
 * §4.1]. Ported from main's `issue/mapping.ts` at the POD-1246 catch-up.
 *
 * Nulls become absent keys, per `../shape.ts`'s convention. Nothing else: the
 * projection is a pure function of the issue's OWN durable row.
 *
 * THAT TOTAL ABSENCE OF A SECOND PARAMETER IS THE D7.2 PROPERTY, not an accident
 * of a small shape. An input this function does not take is a dependency the
 * publish path cannot have: there is no session list to scan, so a session change
 * cannot dirty an issue projection, so no amount of session churn can cost issue
 * -wire work. Main's POD-796 cutover deleted the last such parameter
 * (`IssueDerivedInputs.memberSessionIds`). Keep it that way — a
 * `toWire(issue, somethingElse)` is the shape D7.1/D7.2 forbid growing back, and
 * it will look reasonable the day it is proposed.
 *
 * ---------------------------------------------------------------------------
 * THE INVERSE, AND THE OTHER HALF OF MAIN'S PAIR, DELIBERATELY DO NOT LIVE HERE
 * ---------------------------------------------------------------------------
 *
 * Main's file carried four functions — `toWire` / `fromWire` / `toStorage` /
 * `fromStorage`. Only `toWire` is ported, and the omission is a decision:
 *
 *   - `toStorage` / `fromStorage` (R1 ↔ R3) ALREADY EXIST on this branch, at
 *     `apps/server/src/store/issue-storage.ts` (POD-1151), as a hand-written
 *     per-key mapper. That was measured rather than assumed: `IssueRow` is not a
 *     `Pick` or a mapped type of `IssueAggregate` (stored text vs enums, raw JSON
 *     vs objects, three renames, historical optionality), and a structural
 *     derivation cannot notice two type-identical members being DIFFERENT FACTS —
 *     `intentOrigin` and `audience` are both `'human' | 'agent'` and swapping
 *     them is byte-identical on the wire. Porting main's schema-derived pair
 *     beside it would be the "multiple ad-hoc mappers per hop | Guarantees drift"
 *     alternative ADR 4 D3.4 rejects, in the exact place it rejects it. There is
 *     one R1↔R3 pair on this branch and it is that one.
 *   - `fromWire` (R4 → R1) has no consumer here yet. It is `Issue.parse(
 *     restoreNullValues(projection, IssueAggregate.shape))` when one appears; it
 *     is not written unused, because an unexercised inverse is a bijection claim
 *     nothing checks.
 *
 * So the arrow this branch's publish path walks is
 * `IssueRow ──fromStorage──► StoredIssue ──(+ what storage cannot carry)──►
 * IssueAggregate ──toWire──► IssueProjection`, and only the last hop is here.
 */
export const toWire = (issue: IssueAggregate): IssueProjection =>
  IssueProjection.parse(dropNullValues(issue))
