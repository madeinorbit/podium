/**
 * The REPO field schemas — the vocabulary of the logical repo entity [POD-822].
 *
 * PORTED FROM MAIN at the POD-1246 catch-up (main's `repo/fields.ts`), rehomed
 * from that branch's `repo/` directory into this one's `fields/` + `entities/`
 * split and restated as a `z.object` group like every other member of this
 * directory, so it composes by `.extend()` / `.shape` with the rest.
 *
 * ## What this entity IS
 *
 * The LOGICAL repo, keyed by the stable `repoId` (#74). Deliberately not the
 * `repos` TABLE, which has one row per `(machine_id, path)` — several checkouts
 * of one repo are several rows there and ONE entity here. That is not a
 * simplification: `repo_prefixes` is itself keyed by `repo_id` precisely because
 * "sibling checkouts would need to share a prefix" (repos.ts), so the logical
 * repo is the grain the prefix already lives at. An entity keyed by
 * `(machine, path)` would have to answer "which checkout's prefix?" — a question
 * with no answer.
 *
 * ## NOT `GitRepositoryWire` (`../entities/machine.ts`), despite the name
 *
 * That schema is a per-CHECKOUT machine fact — path, origin URL, worktrees,
 * registration state — inheriting its machine's scoping. This is the logical
 * repo the issue feed joins against. Same English word, two grains, and the
 * `RepoId`-keyed one is the only one a replica can join `displayRef` over.
 *
 * ## Why the entity is this small
 *
 * It carries what the replica must JOIN, not everything a repo has. Paths,
 * origin URLs, worktrees and registration state all reach the client through
 * `repos.listDetailed` (a tRPC read) and are not replicated; nothing in this
 * slice needs them on the feed, and putting them here would replicate a whole
 * subsystem's state to derive one string. Fields join this group when a
 * replica-side derivation needs them — that is what the group is FOR, and D3.3
 * carries them into every representation when they arrive.
 */

import { z } from 'zod'
import { RepoIdField } from '../ids'

/**
 * Identity + the one derivation input [POD-822].
 *
 * `prefix` is here rather than on the issue, and that placement IS the D7.2
 * decision this slice records. It is a function of the REPO: put it on the
 * issue's projection and a prefix change must rewrite every issue in the repo
 * inside one `Ledger.commit()` — O(repo) work on the write path, which D7.2
 * forbids in the same breath as O(world) ("no code on the write, publish, or
 * fan-out path may perform work O(number of entities) per change"). Kept here,
 * a prefix change is ONE upsert of ONE row, and every `displayRef` in the repo
 * moves because the replica re-joins (D7.3).
 *
 * `prefix` is `.nullable()`, NOT `.optional()`, and the distinction is the one
 * `../shape.ts` exists to carry: durable absence is spelled `null` because a
 * sqlite column holds a value or NULL, and the wire projection turns that into
 * an absent key by construction rather than by a hand-written `.optional()` that
 * can drift from its durable twin. `IssueDerived.prefix` in `./issue.ts` is the
 * SERVER-DERIVED read of the same fact and stays optional — it is the join's
 * output, not its input.
 */
export const RepoIdentity = z.object({
  /** Primary key: the stable logical-repo identity (#74). */
  id: RepoIdField,
  /**
   * The human-facing issue-ref prefix — the `POD` in `POD-13` (#474). Unique
   * server-wide; `null` for a repo that has not been given one, which is what
   * makes an issue read `#13` instead.
   *
   * NOT validated against protocol's `^[A-Z]{2,5}$` grammar here, for the reason
   * `Timestamp` records for not being a strict datetime: the model is the
   * vocabulary, not the write-path validator. `setRepoPrefix` enforces the
   * grammar where the write happens (and `repo_prefixes.prefix` enforces
   * uniqueness), so a schema here could only ever refuse a durable row this
   * slice does not own — turning someone else's bad write into OUR parse
   * failure, one repo's whole issue list reading `#13`.
   */
  prefix: z.string().nullable(),
})
export type RepoIdentity = z.infer<typeof RepoIdentity>

/** Every durable Repo field. One group today; the spread is the composition
 *  seam a second group joins without touching any representation [D3.2]. */
export const repoDurableShape = {
  ...RepoIdentity.shape,
} as const
