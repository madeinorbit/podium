import { z } from 'zod'
import { IssueDepIdField, IssueIdField } from '../ids'

/**
 * The dep type as a READER sees it — an open string on purpose.
 *
 * The WRITE side is closed (D7, POD-6100): `issue_deps.type` has a CHECK on
 * `ISSUE_DEP_TYPES`, and `depAdd` parses its input with `StoredIssueDepType`.
 * A reader stays tolerant so a replica cached before that migration, or a
 * server one release behind, still parses; an unknown type simply schedules
 * nothing, since only `blocked-by` does. The one type the service REJECTS
 * ('parent-child', owned by `reparent`) is rejected where that rule lives, in
 * `hierarchy.ts`, not restated here.
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
