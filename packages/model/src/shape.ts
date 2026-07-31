/**
 * PORTED FROM MAIN at the POD-1246 catch-up (POD-795). Integration had NO
 * durable↔wire nullability convention: its field groups spell the transform
 * ad hoc per field (`z.string().nullable().optional().catch(undefined)`), and
 * `representations/` governs WHICH shapes exist rather than transforming them.
 *
 * Confirmed additive, not a rival, by three differently-keyed checks: a name
 * search, a where-would-it-live read of `representations/README.md`, and a
 * structural search for a null↔undefined helper however spelled. It also does not
 * compete with composition — `Pick`ing from shared field groups decides WHICH
 * fields a shape has; this decides how a nullable one crosses the wire.
 *
 * Distinct from `replica.ts`'s assign-`undefined`-never-`delete` rule, which is a
 * client store-update concern at a different layer. An earlier handover note of
 * mine called these two "both sides solved null-encoding differently"; they are
 * different problems and that note was wrong.
 */
import { z } from 'zod'

/**
 * Composition helpers [ADR 4 D3.2: representations compose via shared fragments /
 * `.pick()` / `.extend()` / `Pick`/`Omit` — "never by copy-pasting key lists with
 * fresh `z.string()`"].
 *
 * These express the ROLE-TO-ROLE encoding conventions as ONE rule applied to a
 * whole field group, instead of as N hand-written `.optional()`s that can drift
 * from each other one field at a time. A new field added to a group is carried
 * into every representation by construction — D3.3's "propagates or fails
 * compilation".
 */

/**
 * The R1/R3 → R4 nullability convention, at the type level: a `T | null` durable
 * field becomes an OPTIONAL (absent-when-unset) wire field.
 *
 * Why the roles differ at all: `IssueRow` spells absence `null` (a sqlite column
 * holds a value or NULL — there is no "absent"), while `IssueWire` spells it by
 * omitting the key (a smaller payload, and the convention every existing
 * consumer already reads through truthiness checks). Preserving both encodings —
 * rather than flattening them to one — is what keeps the POD-796 cutover
 * mechanical for both the store and the client.
 */
type WireField<F> = F extends z.ZodNullable<infer Inner> ? z.ZodOptional<Inner> : F
export type WireShape<S extends z.ZodRawShape> = { [K in keyof S]: WireField<S[K]> }

/** Runtime half of {@link WireShape}: unwrap each `.nullable()` and re-wrap `.optional()`. */
export const wireShape = <S extends z.ZodRawShape>(shape: S): WireShape<S> => {
  const out: z.ZodRawShape = {}
  for (const [key, field] of Object.entries(shape)) {
    out[key] = field instanceof z.ZodNullable ? field.unwrap().optional() : field
  }
  return out as WireShape<S>
}

/**
 * Value half of the same convention (durable → wire): drop every `null`.
 *
 * Deliberately keyed on `=== null`, NOT on falsiness. Today's hand-written
 * serializer in `apps/server/src/modules/issues/service/core.ts` spreads
 * `...(row.linearId ? { linearId: row.linearId } : {})`, which also swallows the
 * EMPTY STRING — so a stored `''` reaches the wire as absent and reads back as
 * `null`. That collapse is not round-trippable, and a mapping pair that claims to
 * be a bijection may not inherit it. See `issue/mapping.ts`.
 */
export const dropNullValues = (value: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) if (v !== null) out[key] = v
  return out
}

/**
 * Inverse of {@link dropNullValues} (wire → durable): restore `null` for every
 * NULLABLE field of `shape` the payload does not carry.
 *
 * Only nullable fields are filled: a missing REQUIRED field is a malformed
 * payload, and leaving it absent lets the aggregate's own parse reject it with a
 * precise error rather than silently manufacturing a `null` the schema then
 * blames on the wrong field.
 *
 * ## "Does not carry" means absent OR present-with-`undefined` [POD-795]
 *
 * Deliberately keyed on `out[key] === undefined`, NOT on `!(key in out)`.
 *
 * The wire is JSON, and JSON has no `undefined`: `dropNullValues` omits the key,
 * `JSON.stringify` omits an `undefined` value, and both arrive as the same
 * payload. So `{}` and `{ deferUntil: undefined }` are not two states — they are
 * one value with two in-memory spellings, and an inverse that distinguishes them
 * is distinguishing something the format cannot express.
 *
 * The distinction is not academic: a replica applies deltas through a TanStack
 * change proxy where `delete draft[k]` is a SILENT no-op (POD-794 finding (a), on
 * 0.6.14 and 0.6.16). Clearing a field there means ASSIGNING `undefined` — the
 * only spelling the proxy records — so a replica row for an UNSNOOZED issue
 * holds `deferUntil: undefined` where the wire held nothing at all. Under `in`,
 * that key counts as carried, no null is restored, and the aggregate parse dies
 * with "expected string, received undefined". Under `=== undefined` both
 * spellings restore to `null`, which is what the authority actually said.
 *
 * Pinned on the unsnooze path specifically in
 * `client-core/src/replica/replica.null-encoding.test.ts` — POD-170 shipped
 * broken on exactly that transition once already.
 */
export const restoreNullValues = (
  value: Record<string, unknown>,
  shape: z.ZodRawShape,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...value }
  for (const [key, field] of Object.entries(shape)) {
    if (field instanceof z.ZodNullable && out[key] === undefined) out[key] = null
  }
  return out
}
