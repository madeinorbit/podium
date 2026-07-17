import type { SessionId } from '../ids'
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
 * behaviour, and POD-796 must decide the disposition at cutover: either accept the
 * new (correct) behaviour, or normalise `''` → `null` on the WRITE path so the two
 * agree without the mapping having to lie.
 */

/**
 * Inputs a projection needs that the aggregate does not carry — kept as an
 * explicit parameter so every cross-entity dependency of the wire shape is
 * visible in `toWire`'s signature. If this grows past a couple of fields, that is
 * evidence the projection is drifting back toward the embedded-tree shape D7.1
 * forbids.
 */
export interface IssueDerivedInputs {
  /** The sessions working this issue, by id. See `wire.ts` for why ids only. */
  memberSessionIds: readonly SessionId[]
}

/** R1 → R4. Nulls become absent keys; derived inputs are grafted on. */
export const toWire = (issue: Issue, derived: IssueDerivedInputs): IssueProjection =>
  IssueProjection.parse({
    ...dropNullValues(issue),
    memberSessionIds: derived.memberSessionIds,
  })

/**
 * R4 → R1. Absent keys become nulls; derived fields are dropped (zod's default
 * `strip` removes `memberSessionIds`, which is not in the aggregate's shape).
 */
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
