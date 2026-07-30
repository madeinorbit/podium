/**
 * The CHANGE-LIFECYCLE field vocabulary (POD-305, 2.1) — one definition site for
 * the fields every phase of a change carries.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT IS NOT TRYING TO DELETE
 * ---------------------------------------------------------------------------
 *
 * Change data legitimately exists in three DISTINCT lifecycle phases, and the
 * POD-279 review (finding 2) is explicit that collapsing them is the wrong fix:
 *
 *   1. the STAGED SPEC — what a writer declares at commit time, before the
 *      Authority has assigned it a position (`EntityChangeSpec`);
 *   2. the STORED ROW — what the persistence adapter holds, with the payload
 *      already serialized and an Authority-assigned `seq` and `eventTime`;
 *   3. the SEQUENCED WIRE DELTA — what a reader is handed, with the payload as
 *      the entity's wire projection.
 *
 * They are different types because they are different facts, and a type that
 * tried to be all three would be optional in every position that matters. What
 * is NOT legitimate is each of them RESTATING the field list. `seq`, the target
 * identity, the op vocabulary and the ADR 2 D8 provenance triple mean the same
 * thing in all three, so they are declared here exactly once and composed there.
 *
 * That is the deletion target: hand-restated field lists, not the existence of
 * lifecycle types. `scripts/rearch-audit.ts`' `change-row-typings` item is phrased
 * against restatement for the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 *
 * No `visibility`, no `owner`, no principal, no grant. A change row is the
 * Authority's record of what it wrote; WHO may see it is computed per-principal
 * at the feed boundary (ADR 2 Amendment 1 D12/D13) and is never a column a writer
 * could set wrong. Nor is there a projection function here — README rule 1: this
 * directory says what a field MEANS, never which representation carries it.
 */

import { z } from 'zod'

/**
 * Position in the ONE global sequence (ADR 2 D2, Amendment 1 D12: never
 * renumbered per-principal). Positive, because 0 is the reserved "before any
 * change" cursor value and an assigned seq is never 0.
 */
export const ChangeSeqField = z.number().int().positive()

/**
 * The cursor position a reader holds. Distinct from {@link ChangeSeqField} by
 * exactly one value: 0, meaning "I have seen nothing". Two schemas rather than
 * one loose `nonnegative()` everywhere, because a *row* at seq 0 is malformed and
 * a *cursor* at 0 is the normal cold-start case.
 */
export const ChangeCursorSeqField = z.number().int().nonnegative()

/** The id of the entity a change is about. Unbranded: the change log is
 *  entity-kind-generic and holds session, issue and conversation ids in one
 *  column, so branding here would mean a union that no consumer can narrow. */
export const ChangeEntityIdField = z.string()

/**
 * The ops a GLOBAL change row may carry (ADR 2 D5).
 *
 *  | op                      | means                            | scope  |
 *  |-------------------------|----------------------------------|--------|
 *  | `upsert` w/ `deletedAt` | domain soft-delete, recoverable  | global |
 *  | `remove`                | tombstone — the entity is gone   | global |
 *
 * D5 warns that soft-delete and tombstone "look identical from a distance and are
 * not". They are one op and one flag on purpose: a third global op would be a
 * second way to spell a deletion.
 */
export const GLOBAL_CHANGE_OPS = ['upsert', 'remove'] as const
export const GlobalChangeOpField = z.enum(GLOBAL_CHANGE_OPS)
export type GlobalChangeOp = z.infer<typeof GlobalChangeOpField>

/**
 * The FULL op vocabulary — the global ops plus `evict` (Amendment 1 D14.5).
 *
 * `evict` means "gone from YOUR VIEW — it still exists": a per-principal fact,
 * anchored at the seq of the grant change that caused it (D14.3) and derived at
 * the feed boundary from the visibility policy. It is deliberately NOT a member of
 * {@link GLOBAL_CHANGE_OPS}: stored as a row in the one global log it would be a
 * row with an audience, and no reader of the global log could interpret it.
 *
 * Built by EXTENDING the global tuple rather than by restating three literals, so
 * the two vocabularies cannot drift and "is this op global?" has one answer.
 */
export const CHANGE_OPS = [...GLOBAL_CHANGE_OPS, 'evict'] as const
export const ChangeOpField = z.enum(CHANGE_OPS)
export type ChangeOp = z.infer<typeof ChangeOpField>

/** Is this op one a global change row may carry? The one answer, so a caller
 *  never re-derives it by comparing against the `evict` literal. */
export function isGlobalChangeOp(op: ChangeOp): op is GlobalChangeOp {
  return (GLOBAL_CHANGE_OPS as readonly string[]).includes(op)
}

/** The Authority-assigned commit time a `field-LWW` row arbitrates on (ADR 1 D3
 *  condition 1 — see `FIELD_LWW_CLOCK`). Epoch milliseconds. A client wall clock
 *  never lands here; it may be attribution metadata only. */
export const ChangeEventTimeField = z.number().int().nonnegative()

/**
 * ADR 2 D3 — the monotonic, Authority-assigned, per-entity token. Opaque to
 * replicas: a replica stores and echoes it and NEVER compares it for truth.
 * Nonnegative rather than positive so "never yet revised" has a value.
 */
export const ChangeRevisionField = z.number().int().nonnegative()

/**
 * ADR 2 D8 — origin, causation and mutation identity ride the ENVELOPE, never the
 * entity payload.
 *
 * Putting them in the payload would make the change log's byte-equality dedup fire
 * on provenance churn (a re-submitted no-op write would append a row because its
 * causationId differed) and would drag provenance into every wire projection,
 * which ADR 4 forbids.
 *
 * All three are optional at the field level because a change the Authority makes
 * on its own behalf — a boot reconcile, a steward sweep — has no causing command.
 * Requiredness is a per-phase decision made where the phase is composed, which is
 * README rule 2: declare requiredness where the fact is always true.
 */
export const ChangeProvenanceFields = z.object({
  /** Which peer authored this change (echo suppression, loop prevention). */
  originId: z.string().optional(),
  /** Which command caused it — resolves to an outbox entry's `mutationId`. */
  causationId: z.string().optional(),
  /** The client-minted idempotency key of that command. */
  mutationId: z.string().optional(),
})
export type ChangeProvenanceFields = z.infer<typeof ChangeProvenanceFields>

/**
 * The (entity kind, entity id) pair a change targets, as the Authority and its
 * persistence adapter spell it.
 *
 * The WIRE spells the id half `id` rather than `entityId` and this schema
 * deliberately does not try to unify the two: renaming a wire key is a protocol
 * break that POD-308's cutover owns, and quietly shipping one from a field-schema
 * refactor is exactly the kind of change that is invisible until a client that was
 * not rebuilt drops every row. What IS shared is the field's meaning and its
 * schema — `ChangeEntityIdField` above — which is the part that was restated.
 */
export const ChangeTargetFields = z.object({
  entity: z.string(),
  entityId: ChangeEntityIdField,
})
export type ChangeTargetFields = z.infer<typeof ChangeTargetFields>

/**
 * The stored payload: the entity's wire JSON, serialized, or NULL for a `remove`.
 *
 * Serialized at the storage phase and not before, because the change log's dedup
 * compares SERIALIZED BYTES — a staged spec holding a live object and a stored row
 * holding its JSON are the same fact at two phases, and the phase where the bytes
 * become authoritative is this one.
 */
export const ChangePayloadField = z.string().nullable()
