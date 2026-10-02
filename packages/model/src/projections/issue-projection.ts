

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
  // NeedsHuman) with optional historical attribution, and `options` is
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
