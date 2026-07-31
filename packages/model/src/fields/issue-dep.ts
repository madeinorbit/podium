/**
 * THE issue dep-edge vocabulary [ADR 4 D1] — the field group every
 * representation of a dependency edge composes from [POD-822].
 *
 * PORTED FROM MAIN at the POD-1246 catch-up (the shape half of main's
 * `issue/dep.ts`), rehomed into this tree's `fields/` + `entities/` split; the
 * id brand moved to `../ids/brands.ts` and its constructor to `../ids/keys.ts`,
 * which are this tree's single homes for a brand and for a composite key.
 *
 * ## Why an entity rather than a field on the issue
 *
 * `deps` is a RELATION (`issue_deps`, PK `(from_id, to_id, type)`), not a column
 * of `issues`. D7.1 does NOT forbid the embedded `deps: [{ id, type }]` this
 * tree's `IssueWireCore` carries — that is reference-by-branded-id, which D7.1
 * permits. The edge must become an ENTITY for a different reason, decided at
 * POD-1254: `blocked` belongs at the replica under D7.3, and A REPLICA CAN ONLY
 * JOIN OVER EDGES IT HAS BEEN SENT. Anyone re-deriving this from "a kind on the
 * feed is an entity" reaches the right answer for the wrong reason and will
 * mishandle the next edge type.
 *
 * D7.2 is the second half: an edge belongs to TWO issues, so putting it on one
 * issue's projection makes closing issue B recompute issue A's payload. As its
 * own entity an edge change costs O(1) — `depAdd` upserts ONE row and nothing
 * else re-derives server-side.
 *
 * ## `dependents` is not here, and cannot be
 *
 * `dependents` is the REVERSE index of `deps` — the same rows read the other way
 * round. A replica holding the edge set indexes it by `toId` as cheaply as by
 * `fromId`. Emitting a second, reversed copy would be two spellings of one edge
 * with nothing to arbitrate between them.
 *
 * ## No `revision`, deliberately
 *
 * Every other replicated entity carries one [ADR 2 D3]; this one does not, and
 * the asymmetry is honest rather than an oversight. An edge has NO MUTABLE
 * STATE: `(fromId, toId, type)` is the entire row AND its primary key, so there
 * is no field a write could change and no "is my write based on current truth?"
 * question to ask — the edge exists or it does not, and upsert/remove is its
 * whole lifecycle. A revision here could only ever read `1`.
 *
 * Nor is one needed for concurrency: `depAdd`/`depRemove` take
 * `expectedRevision` against the FROM ISSUE, which is where ADR 1's matrix
 * already puts the precondition. Minting a second token on the edge would give
 * two answers to one question.
 */

import { z } from 'zod'
import { IssueDepIdField, IssueIdField } from '../ids'

/**
 * The dep type — an OPEN string, matching the durable column.
 *
 * `@podium/protocol` lists eight known types in `ISSUE_DEP_TYPES`, but nothing
 * enforces them: `issue_deps.type` is `TEXT NOT NULL DEFAULT 'blocks'` with no
 * CHECK, `addIssueDep(from, to, type = 'blocks')` accepts any string, and the
 * `depAdd` command's input is `z.string().optional()`. So an enum here would
 * refuse durable rows this slice does not own — the same reasoning `Timestamp`
 * records for not being a strict datetime. The one type the service REJECTS
 * ('parent-child', owned by `reparent`) is rejected where that rule lives, in
 * `crud.ts`, not restated here.
 */
export const IssueDepType = z.string().min(1)
export type IssueDepType = z.infer<typeof IssueDepType>

/**
 * WHICH EDGE. All three references are branded ids (D3.5, D7.1's "references
 * other entities by branded id only").
 *
 * `id` is REDUNDANT with `(fromId, toId, type)` by construction — it is the
 * composed key, carried because the feed addresses entities by a single id and a
 * consumer should never have to re-derive its own addressing. `parseIssueDepId`
 * (`../ids/keys.ts`) exists so the redundancy stays checkable.
 *
 * NO NULLABLE MEMBER, which is why `../shape.ts`'s convention is the identity on
 * this group — see `../entities/issue-dep.ts` for why it is applied anyway.
 */
export const IssueDepEdge = z.object({
  /** The composed primary key — see `issueDepId` in `../ids/keys.ts`. */
  id: IssueDepIdField,
  /** The DEPENDENT: the issue that is blocked / related / superseded. */
  fromId: IssueIdField,
  /** The DEPENDED-UPON: what `fromId` waits for. `blocked` means this one is not
   *  done yet. */
  toId: IssueIdField,
  type: IssueDepType,
})
export type IssueDepEdge = z.infer<typeof IssueDepEdge>

/** Every durable dep-edge field. One group today; the spread is the composition
 *  seam a second group joins without touching any representation [D3.2]. */
export const issueDepDurableShape = {
  ...IssueDepEdge.shape,
} as const
