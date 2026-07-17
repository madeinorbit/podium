import { dropNullValues, restoreNullValues } from '../shape'
import { Issue } from './aggregate'
import { IssuePanel, issueDurableShape } from './fields'
import { IssueStorageRow } from './storage'
import { IssueProjection } from './wire'

/**
 * **THE Issue mapping pair** [ADR 4 D3.4: "One documented store-row ↔ wire mapping
 * function per entity (and the inverse as the kernel lands). Mapping is code, not
 * tribal knowledge." — and §4.1, which names `toWire` / `fromWire` / `toStorage` /
 * `fromStorage` exactly].
 *
 * ONE file, four functions, no second path. The ADR's rejected alternative
 * "Multiple ad-hoc mappers per hop | Guarantees drift" is the thing this file
 * exists to prevent, so if a consumer needs a different encoding the answer is to
 * change the vocabulary or the overrides — never to write a second mapper.
 *
 * Every function is total and every pair is a BIJECTION over valid values:
 *
 *   fromWire(toWire(issue, derived))  ≡ issue
 *   fromStorage(toStorage(issue))     ≡ issue
 *
 * `issue.mapping.test.ts` proves both, field-by-field, over a fixture that sets
 * every nullable field BOTH ways — because a round-trip test that only exercises
 * the populated case cannot see a null/absent bug, which is the entire failure
 * mode this pair is here to prevent.
 *
 * ## The bijection is not free, and one existing behaviour breaks it
 *
 * Today's serializer (`apps/server/src/modules/issues/service/core.ts`) omits by
 * TRUTHINESS: `...(row.linearId ? { linearId: row.linearId } : {})`. An empty
 * string is falsy, so a stored `''` reaches the wire as absent and reads back as
 * `null` — `'' → null` is a silent, lossy round-trip. This pair omits on `=== null`
 * instead, so `''` survives. That is a DELIBERATE divergence from today's wire
 * behaviour.
 *
 * SETTLED at the [POD-796] cutover: accept it. The divergence was measured against
 * the live DB (793 issues) rather than argued — the whole surface is `assignee = ''`
 * on 2 rows, where `''` and absent render identically under any truthiness check.
 * (`description = ''` on 146 rows is NOT in scope: today's serializer passes
 * description through unconditionally, so `''` already survives on both paths.)
 * The mapping therefore does not have to lie, and the bijection stands.
 *
 * The honest fix — make `null` the ONE spelling for absent by normalising on the
 * WRITE path — is POD-820, deliberately not done here: it is a data migration
 * touching every nullable text field, and putting one inside a flag-gated wire
 * cutover would cost the cutover its reversibility.
 */

/**
 * R1 → R4. Nulls become absent keys. Nothing else: the projection is a pure
 * function of the issue's OWN durable row.
 *
 * That total absence of a second parameter is the D7.2 property, not an
 * accident of a small shape. An input this function does not take is a
 * dependency the publish path cannot have: there is no session list to scan, so
 * a session change cannot dirty an issue projection, so no amount of session
 * churn can cost issue-wire work. The [POD-796] cutover deleted the last such
 * parameter (`IssueDerivedInputs.memberSessionIds`) — see `wire.ts`.
 *
 * Keep it that way. A `toWire(issue, somethingElse)` is the shape D7.1/D7.2
 * forbid growing back, and it will look reasonable the day it is proposed.
 */
export const toWire = (issue: Issue): IssueProjection =>
  IssueProjection.parse(dropNullValues(issue))

/** R4 → R1. Absent keys become nulls. The inverse of `toWire`, total both ways. */
export const fromWire = (projection: IssueProjection): Issue =>
  Issue.parse(restoreNullValues(projection, issueDurableShape))

/** R1 → R3. Structured panel is encoded to its JSON TEXT column. */
export const toStorage = (issue: Issue): IssueStorageRow =>
  IssueStorageRow.parse({
    ...issue,
    panel: issue.panel === null ? null : JSON.stringify(issue.panel),
  })

/**
 * R3 → R1. Decodes the panel column and narrows the widened TEXT enums.
 *
 * STRICT: throws on a row it cannot make sense of, rather than degrading. Today's
 * reader does the opposite — `parsePanel` swallows a JSON error into an empty
 * panel and the stage/type casts are unchecked — which means a corrupt value is
 * currently indistinguishable from an empty one at every call site downstream.
 * A model boundary should refuse what it does not understand; POD-796 owns the
 * call on whether the cutover wraps this in a per-row guard so one bad row cannot
 * fail a whole list read.
 */
export const fromStorage = (row: IssueStorageRow): Issue =>
  Issue.parse({ ...row, panel: decodePanel(row.panel) })

/** The only place the panel JSON column is decoded. */
const decodePanel = (encoded: string | null): IssuePanel | null => {
  if (encoded === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch (cause) {
    throw new Error(`issue panel column is not valid JSON: ${encoded.slice(0, 80)}`, { cause })
  }
  return IssuePanel.parse(parsed)
}
