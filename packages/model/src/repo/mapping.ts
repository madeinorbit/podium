import { dropNullValues, restoreNullValues } from '../shape'
import { repoDurableShape } from './fields'
import { Repo, RepoProjection } from './wire'

/**
 * **THE Repo mapping pair** [ADR 4 D3.4, §4.1].
 *
 * Named `repoToWire` / `repoFromWire` rather than the bare `toWire` / `fromWire`
 * the Issue pair uses, for a boring reason worth stating so the asymmetry does
 * not read as sloppiness: `packages/model`'s index re-exports every entity with
 * `export *`, so two bare `toWire`s would be a name collision at the package
 * root. Issue's holds the bare name because it was there first; every entity
 * after it qualifies.
 *
 * There is no `toStorage`/`fromStorage` half. `repo_prefixes` is
 * `(repo_id, prefix)` and the aggregate is `(id, prefix)` — a key rename, no
 * encoding. The rename lives at the server's adapter
 * (`apps/server/src/modules/issues/projection.ts`), which is the same place
 * `IssueRow`'s spelling is reconciled with `IssueStorageRow`'s, and for the same
 * reason: how a hand-written server row spells a column is the one thing the
 * model cannot know.
 */

/** R1 → R4. `prefix: null` (no prefix chosen) becomes an absent key, which is
 *  what makes `issueDisplayRef` fall back to `#13` replica-side. */
export const repoToWire = (repo: Repo): RepoProjection => RepoProjection.parse(dropNullValues(repo))

/** R4 → R1. The inverse: an absent `prefix` restores to `null`. Total both ways. */
export const repoFromWire = (projection: RepoProjection): Repo =>
  Repo.parse(restoreNullValues(projection, repoDurableShape))
