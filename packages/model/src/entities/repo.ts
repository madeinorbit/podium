/**
 * THE logical repo entity — R1, its R4 projection, and the one mapping pair
 * between them [ADR 4 D2, D3.4; POD-822].
 *
 * PORTED FROM MAIN at the POD-1246 catch-up (main's `repo/wire.ts` and
 * `repo/mapping.ts`, merged into one file because two 25-line halves of one
 * entity are not two files in this tree's layout). The vocabulary they compose
 * from is `../fields/repo.ts`.
 *
 * WHY THE ENTITY EXISTS AT ALL — settled at POD-1254 from ADR 4 D7.2, not from
 * "a kind on the feed is an entity". `prefix` carried on every issue's wire
 * means one repo's prefix change invalidates every issue in that repo: O(issues)
 * on the fan-out path from a one-row edit, structurally the embedded
 * `SessionMeta[]` that D7 was written to make unrepresentable. D7.4 prescribes
 * the remedy verbatim — a first-class materialized entity updated incrementally
 * by the command that changes its input, carrying its own revision, on the
 * normal feed. A prefix change becomes one row.
 */

import { z } from 'zod'
import { repoDurableShape } from '../fields/repo'
import { dropNullValues, restoreNullValues, wireShape } from '../shape'

/**
 * **R1 — the canonical durable Repo aggregate** [ADR 4 D2]. Composed wholly from
 * `../fields/repo.ts`; declares no field of its own.
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
 * `IssueViewInput`.
 *
 * Pure function of the repo's own row, exactly like `IssueProjection`: an issue
 * change cannot dirty a repo projection, and a repo change dirties one row.
 * That is D7.2 held structurally on both sides of the join rather than
 * remembered on either.
 */
export const RepoProjection = z.object(wireShape(repoDurableShape))
export type RepoProjection = z.infer<typeof RepoProjection>

/**
 * **THE Repo mapping pair** [ADR 4 D3.4, §4.1].
 *
 * Named `repoToWire` / `repoFromWire` rather than a bare `toWire` / `fromWire`
 * for a boring reason worth stating so the asymmetry does not read as
 * sloppiness: `packages/model`'s index re-exports every entity with `export *`,
 * so two bare `toWire`s would be a name collision at the package root.
 *
 * There is no `toStorage`/`fromStorage` half. `repo_prefixes` is
 * `(repo_id, prefix)` and the aggregate is `(id, prefix)` — a key rename, no
 * encoding. The rename lives at the server's adapter
 * (`apps/server/src/modules/issues/projection.ts`), which is the same place a
 * hand-written server row's spelling is reconciled generally, and for the same
 * reason: how a hand-written server row spells a column is the one thing the
 * model cannot know.
 */

/** R1 → R4. `prefix: null` (no prefix chosen) becomes an absent key, which is
 *  what makes `issueDisplayRef` fall back to `#13` replica-side. */
export const repoToWire = (repo: Repo): RepoProjection => RepoProjection.parse(dropNullValues(repo))

/** R4 → R1. The inverse: an absent `prefix` restores to `null`. Total both ways. */
export const repoFromWire = (projection: RepoProjection): Repo =>
  Repo.parse(restoreNullValues(projection, repoDurableShape))
