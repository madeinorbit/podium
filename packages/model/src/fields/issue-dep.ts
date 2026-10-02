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
