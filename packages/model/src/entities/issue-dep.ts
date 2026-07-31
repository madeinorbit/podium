/**
 * THE issue dependency edge as a first-class replicated entity — R1, its R4
 * projection, and the one mapping pair between them [ADR 4 D2, D3.4; POD-822,
 * POD-1254].
 *
 * PORTED FROM MAIN at the POD-1246 catch-up (the representation half of main's
 * `issue/dep.ts`). The vocabulary is `../fields/issue-dep.ts`; the id brand is
 * in `../ids/brands.ts` and its constructor in `../ids/keys.ts`.
 */

import { z } from 'zod'
import { issueDepDurableShape } from '../fields/issue-dep'
import { dropNullValues, restoreNullValues, wireShape } from '../shape'

/** **R1** — the canonical durable dep edge [ADR 4 D2]. One `issue_deps` row. */
export const IssueDep = z.object(issueDepDurableShape)
export type IssueDep = z.infer<typeof IssueDep>

/** **R4** — the dep edge's wire/read projection [ADR 4 D2]. Identical to R1: the
 *  group has no nullable field, so `wireShape` is the identity here. It is
 *  applied anyway rather than skipped, so that a nullable field added to the
 *  group later gets the wire encoding by construction (D3.3) instead of by
 *  someone remembering to. */
export const IssueDepProjection = z.object(wireShape(issueDepDurableShape))
export type IssueDepProjection = z.infer<typeof IssueDepProjection>

/**
 * **The dep-edge mapping pair** [ADR 4 D3.4 — "one documented store-row ↔ wire
 * mapping function per entity … Mapping is code, not tribal knowledge"].
 *
 * Both directions are the IDENTITY today, because the group has no nullable
 * field for the null↔absent convention to act on. They are written as the
 * convention applied (`dropNullValues` / `restoreNullValues`) rather than as
 * `x => x` for the same reason `wireShape` is applied above: the day a nullable
 * field joins the group, its encoding follows by construction (D3.3) instead of
 * by someone noticing that two identity functions had stopped being identities.
 *
 * There is no `toStorage`/`fromStorage` half, and that is not a gap: `issue_deps`
 * columns ARE `(from_id, to_id, type)`, so R1 and R3 coincide and a pair would
 * be two more identities. The one encoding the store does not have — the
 * composed `id` — is `issueDepId` / `parseIssueDepId` in `../ids/keys.ts`; that
 * IS this entity's store↔wire mapping.
 */
export const issueDepToWire = (dep: IssueDep): IssueDepProjection =>
  IssueDepProjection.parse(dropNullValues(dep))

/** R4 → R1. The inverse of {@link issueDepToWire}. */
export const issueDepFromWire = (projection: IssueDepProjection): IssueDep =>
  IssueDep.parse(restoreNullValues(projection, issueDepDurableShape))
