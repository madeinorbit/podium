import { z } from 'zod'
import { wireShape } from '../shape'
import { repoDurableShape } from './fields'

/**
 * **R1 — the canonical durable Repo aggregate** [ADR 4 D2]. Composed wholly from
 * `./fields.ts`; declares no field of its own.
 */
export const Repo = z.object(repoDurableShape)
export type Repo = z.infer<typeof Repo>

/**
 * **R4 — the Repo wire/read projection** [ADR 4 D2; POD-822].
 *
 * The entity that closes the `prefix` half of the POD-796 cutover gap. Before
 * it there was no 'repo' kind on the feed at ALL, so `issueDisplayRef` had no
 * replica-side source for a prefix and fell back to `#13` for every issue that
 * should read `POD-13` — silently, because `prefix` is optional on
 * `IssueViewInput` (see the tripwire this slice deletes in `issue-views.ts`).
 *
 * Pure function of the repo's own row, exactly like `IssueProjection`: an issue
 * change cannot dirty a repo projection, and a repo change dirties one row.
 * That is D7.2 held structurally on both sides of the join rather than
 * remembered on either.
 */
export const RepoProjection = z.object(wireShape(repoDurableShape))
export type RepoProjection = z.infer<typeof RepoProjection>
