/**
 * THE ONE CHANGE-ROW ARM SHAPE, for both wire versions (POD-308).
 *
 * `messages/sync.ts` (v1) and `messages/feed.ts` (v2) each need a five-field arm
 * per entity kind, and the two differ in exactly two things: v1 spells the target
 * `id` and admits `upsert | remove`; v2 spells it `entityId` and admits `evict`
 * as well. Everything else — the field list, its ORDER, the shared model
 * instances it composes, the "value is present iff upsert" rule — is common.
 *
 * Declaring it twice would have been the restatement this rewrite's
 * `change-row-typings` item exists to delete, and it would have been invisible:
 * two arm factories that agree today produce byte-identical wire output, so no
 * golden fixture and no typecheck can see them drift. So there is one factory,
 * parameterised by the two things that genuinely differ, and the v1 shape is
 * spelled `id` HERE — which means the v1/v2 rename is a single argument at one
 * call site rather than a second definition of what a change row is.
 *
 * KEY ORDER IS PART OF THE CONTRACT. Zod emits parsed keys in shape order, so
 * `seq, entity, <id>, op, value` is pinned by `wire-golden.json`; the target-id
 * key is written in its third position by construction, not by both callers
 * remembering to put it there.
 */

import { ChangeEntityIdField, ChangeSeqField } from '@podium/model'
import { z } from 'zod'

/**
 * One arm of a change union.
 *
 * @param idKey  `'id'` on wire v1, `'entityId'` on wire v2 (the kernel's
 *               spelling). The rename POD-308 owns, as an argument.
 * @param op     the op VOCABULARY schema — `GlobalChangeOpField` for a global
 *               log row, `ScopedChangeOp` for a per-principal feed row. Passed
 *               in rather than chosen here, because which ops a row may carry is
 *               a property of the log it belongs to (ADR 2 Am1 D14.5).
 */
export const changeRowArm = <
  K extends 'id' | 'entityId',
  E extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  V extends z.ZodTypeAny,
>(
  idKey: K,
  entity: E,
  op: O,
  value: V,
) =>
  z
    .object({ seq: ChangeSeqField, entity })
    // The target-id key by NAME, in its third position. `.extend` appends, so the
    // wire order `seq, entity, <id>, op, value` is produced by construction here
    // rather than by both callers remembering it.
    .extend({ [idKey]: ChangeEntityIdField } as { [P in K]: typeof ChangeEntityIdField })
    .extend({ op, value: value.optional() })
