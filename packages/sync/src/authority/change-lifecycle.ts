/**
 * THE THREE LIFECYCLE PHASES OF A CHANGE — distinct types, one vocabulary.
 *
 * POD-279's review, finding 2: change data legitimately exists in distinct
 * lifecycle phases, and the deletion target is hand-restated field lists rather
 * than the existence of the phases. So this module keeps three types and gives
 * them ONE source of field meaning — `@podium/model`'s change vocabulary.
 *
 *   1. {@link StagedChangeSpec} — the STAGED SPEC. What a writer declares at
 *      commit time: what changed, and to what. No position: the Authority has not
 *      assigned one yet, and a spec that could carry a `seq` would invite a caller
 *      to pick one.
 *   2. {@link StoredChangeRow} — the STORED ROW. Payload already SERIALIZED,
 *      because the change log's dedup compares bytes; plus the Authority-assigned
 *      `eventTime`, which is the only clock ADR 1 D3 lets `field-LWW` arbitrate on.
 *   3. {@link SequencedChange} — the SEQUENCED DELTA. The row with its position in
 *      the one global sequence, as a reader is handed it.
 *
 * WHY THE PHASES ARE NOT COLLAPSED, restated so a later tidy-up does not:
 * a single type would have to make `seq` optional (absent before commit), the
 * payload both object and string (live before storage, serialized after), and
 * `eventTime` optional (assigned at commit). Every field that matters would be
 * optional, and "is this staged or stored?" would become a runtime guess at every
 * call site. Three types make the phase a compile-time fact.
 *
 * WHAT IS DELIBERATELY NOT HERE: the WIRE delta. `@podium/protocol`'s
 * `MetadataChange` is the pre-cutover wire shape and POD-308 owns bringing it onto
 * this vocabulary; it already composes the same model field schemas, which is the
 * half that could be done without a wire break. And nothing here names a
 * principal, an owner or a visibility class — who may see a change is computed at
 * the feed boundary (ADR 2 Am1 D12/D13), never carried on the row.
 */

import {
  ChangeEventTimeField,
  ChangeOpField,
  ChangePayloadField,
  ChangeProvenanceFields,
  ChangeSeqField,
  ChangeTargetFields,
  GlobalChangeOpField,
} from '@podium/model'
import { MetadataEntityKind } from '@podium/protocol'
import { z } from 'zod'

/**
 * PHASE 1 — what a writer declares at commit time.
 *
 * NAMED for its phase rather than `EntityChangeSpec`, and not only to avoid the
 * collision with `../ledger`'s pre-cutover spelling: "staged" is the fact that
 * distinguishes it from the two phases after it, and a name that says which phase
 * it is makes a call site holding the wrong one a compile error with a readable
 * message instead of a structural mismatch.
 *
 * `entity` narrows the shared target group's plain `string` to the entity kinds
 * this Authority actually logs. The narrowing is at THIS phase and not in the
 * model on purpose: the change log is kind-generic (one column holds session,
 * issue and conversation ids), and a reader of the stored log must tolerate a
 * kind a newer build wrote (ADR 2 D9). Only the WRITER is constrained, and only
 * here, where a typo in an entity name is a bug rather than forward compatibility.
 */
export const StagedChangeSpec = ChangeTargetFields.omit({ entity: true })
  .extend({ entity: MetadataEntityKind })
  .extend({
    op: GlobalChangeOpField,
    /** The entity's WIRE shape. Present iff `op === 'upsert'`. */
    value: z.unknown().optional(),
  })
  .extend(ChangeProvenanceFields.shape)
export type StagedChangeSpec = z.infer<typeof StagedChangeSpec>

/**
 * PHASE 2 — the row as the persistence adapter holds it.
 *
 * The payload is a SERIALIZED string (or null for a `remove`) because dedup
 * compares bytes; `eventTime` is the Authority's commit clock. Neither exists at
 * phase 1 and both are required here, which is the requiredness-where-the-fact-
 * is-true rule from `fields/README.md`.
 */
export const StoredChangeRow = StagedChangeSpec.omit({ value: true }).extend({
  payload: ChangePayloadField,
  eventTime: ChangeEventTimeField,
})
export type StoredChangeRow = z.infer<typeof StoredChangeRow>

/**
 * PHASE 3 — the row with its position in the ONE global sequence.
 *
 * `seq` is assigned by the append and is never renumbered per-principal
 * (ADR 2 Amendment 1 D12). The payload is back to the live wire value here
 * because a reader wants the entity, not its bytes.
 */
export const SequencedChange = StagedChangeSpec.extend({ seq: ChangeSeqField })
export type SequencedChange = z.infer<typeof SequencedChange>

/**
 * PHASE 4 — the row AS ONE PRINCIPAL RECEIVES IT (POD-1077).
 *
 * The one difference from phase 3, and the reason it is a fourth phase rather
 * than a widened third: the op vocabulary here is the FULL {@link ChangeOpField}
 * (`upsert | remove | evict`), while a stored global row can only ever be
 * `upsert | remove`.
 *
 * `evict` means "this left YOUR VIEW — it still exists" (Amendment 1 D14.1). It
 * is per-principal by construction: it is DERIVED at the scoping boundary from
 * the visibility policy, never appended to the global log, and never written by a
 * caller. Keeping the phases separate is what makes that a compile-time fact —
 * `SequencedChange` has nowhere to put an `evict`, so a global row carrying one
 * does not typecheck, and the type of `Authority.capture` is the enforcement.
 *
 * The subset relation runs the safe way for the same reason
 * `feed/publisher.ts:toEnvelope` needs no cast: `CHANGE_OPS` is built by
 * EXTENDING `GLOBAL_CHANGE_OPS`, so every phase-3 row is a valid phase-4 row and
 * the day someone adds a fourth global op is a type error rather than a silent
 * widening.
 */
export const ScopedChange = SequencedChange.extend({ op: ChangeOpField })
export type ScopedChange = z.infer<typeof ScopedChange>
