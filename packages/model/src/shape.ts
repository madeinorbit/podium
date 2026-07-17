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
 * NULLABLE field of `shape` the payload omits.
 *
 * Only nullable fields are filled: a missing REQUIRED field is a malformed
 * payload, and leaving it absent lets the aggregate's own parse reject it with a
 * precise error rather than silently manufacturing a `null` the schema then
 * blames on the wrong field.
 */
export const restoreNullValues = (
  value: Record<string, unknown>,
  shape: z.ZodRawShape,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...value }
  for (const [key, field] of Object.entries(shape)) {
    if (field instanceof z.ZodNullable && !(key in out)) out[key] = null
  }
  return out
}
