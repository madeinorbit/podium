/**
 * `OpStreamDocument` — the shape reserved for collaborative text (POD-365).
 *
 * ADR 1 Amendment 1 D12 reserves a sixth conflict class, `op-stream`, for a
 * SMALL NAMED SET: the session composer draft body, issue `description`, and
 * issue `notes`. Membership is closed and adding to it requires an ADR 1
 * amendment — "text fields" is explicitly rejected as unauditable, so issue
 * `title` / `brief` / `activityNotes`, comments and session `name` / `title` are
 * NOT members and must not be given this shape by convenience. PTY input is
 * excluded by a different argument entirely: two people typing into one terminal
 * is a CONTROL problem, already modelled by `controllerId` / `requestControl`.
 *
 * ---------------------------------------------------------------------------
 * RESERVED, NOT BUILT — and the shape is the reservation
 * ---------------------------------------------------------------------------
 *
 * This file builds no op stream. There is no op type, no sequencer, no merge.
 * What it does is give the three members a shape that CAN grow an op tail, so
 * that the day the class is implemented is not also the day their wire shape
 * changes. `docs/rearch-field-schema-inventory.md` §8 asks for exactly this: a
 * field schema *"shaped for that future — a materialized string today, with the
 * op tail added beside it — rather than a plain `z.string()` that has to change
 * shape later"*.
 *
 * THE CONSTRAINT THAT TRAVELS WITH THE CLASS (ADR 1 Am1 D12 part 3, protecting
 * ADR 2 D5, and restated verbatim as {@link OP_STREAM_COMPACTION_CONSTRAINT} in
 * `../annotations/ownership.ts`): ADR 2 D5's retention-safety proof depends on
 * the bootstrap snapshot being POSITIVE STATE. A document reconstructed by
 * replaying an unbounded op log breaks that proof and needs the log-compaction
 * ADR that ADR 2 D5 already parks. A document carrying its MATERIALIZED VALUE
 * plus a BOUNDED recent-op tail keeps D5 intact. That is why `value` below is
 * the required member and the tail is the additive one — the reverse shape would
 * be the non-compliant design, expressed as a schema.
 *
 * TODAY'S CONFLICT RULE IS UNCHANGED. All three members stay `field-LWW` on the
 * matrix, with D10's named interim defect recorded against the composer draft:
 * before session sharing ships (Phase 3, POD-290) it must either move to
 * `op-stream` or be gated to a single writer. Shipping neither is out of
 * compliance. Nothing here accelerates that; it only stops the shape from being
 * the obstacle.
 */

import { z } from 'zod'

/**
 * A collaborative-text field: its materialized value, and room beside it.
 *
 * `value` is a plain string and is REQUIRED, so composing this in place of a
 * `z.string()` is shape-compatible at the value position and every reader that
 * wants the text reads one key. The optional members are the reservation:
 *
 *   - `revision` — the Authority-assigned sequence position the materialized
 *     value reflects. Absent while the class is unbuilt.
 *   - `ops` — the BOUNDED recent-op tail. Deliberately `z.unknown()`: the op
 *     vocabulary is the unbuilt part, and inventing one here would be building
 *     the class rather than reserving it. What is fixed is that it is a bounded
 *     ARRAY sitting BESIDE a materialized value, which is the property ADR 2 D5
 *     actually needs.
 *
 * The optionality is what makes the eventual arrival additive, and it is also
 * the README rule 2 case: a scoped projection that suppresses a document body
 * omits the whole group; it does not need this schema to have anticipated it.
 */
export const OpStreamDocument = z.object({
  /** The materialized document. The positive state ADR 2 D5's proof requires. */
  value: z.string(),
  /** Authority-assigned position this materialization reflects (ADR 1 D1: the
   *  Replica applies an ordering someone else decided; it never arbitrates). */
  revision: z.number().int().nonnegative().optional(),
  /** The bounded recent-op tail. Unbuilt — see the file header. */
  ops: z.array(z.unknown()).optional(),
})
export type OpStreamDocument = z.infer<typeof OpStreamDocument>

/** The closed member set of ADR 1 Am1 D12's reserved class, as data — so
 *  "is this an op-stream member?" has one answer and a test can enumerate it.
 *  Adding an entry here without the ADR 1 amendment is the drift D12 rejects. */
export const OP_STREAM_MEMBERS = [
  'session.composerDraft',
  'issue.description',
  'issue.notes',
] as const
export type OpStreamMember = (typeof OP_STREAM_MEMBERS)[number]
