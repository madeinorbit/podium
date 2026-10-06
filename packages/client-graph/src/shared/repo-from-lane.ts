/**
 * POD-4695 — the repo-from-lane composition, owned once in the shared feed
 * layer (M3 N5; M4 lesson 1 row 5).
 *
 * OWNING LAYER. The schema (`schema.ts` `repo.components`) already declares
 * WHAT a repo is — the replicated `(id, prefix)` row joined with the
 * machine's scan row — but the schema holds no behaviour by design (plain
 * data, no classes). The feed (`row-source.ts`) routes repo facts onto lanes
 * (`laneFor`, `lanesOf`, `resolveReposFanout`). What was still per-arm is the
 * other direction: how a `worktree` record becomes the `repo` entity's row.
 * That routing lives here, once, and both arms' `pool/tables.ts` delegate to
 * it; neither arm keeps a local composition. The one field the feed spells
 * differently (`repo.path` arrives as the lane's `repoPath`) is declared here
 * too, and both arms' field layers (`arms/mobx/pool/models.ts`,
 * `arms/hand/pool/records.ts`) import that spelling instead of restating it.
 *
 * THE COMPOSITION (moved verbatim from the two arms, which agreed line for
 * line except for the stated no-relations policy below).
 * - A `worktree` record whose value has no `path` is the raw replicated repo
 *   row (`row-source.ts` `resolveReposFanout`): held as the repo's row until
 *   a lane arrives, and never replacing a lane.
 * - A lane carrying a `repoId` IS the repo's row (the latest such lane wins);
 *   the repo table holds the borrowed lane object, never a copy.
 * - When the holding lane leaves (or moves to another repo), another of the
 *   repo's lanes takes over, found through the maintained `repo.worktrees`
 *   collection; the repo leaves with its last lane. This is feed-shape
 *   composition, not relation maintenance: the takeover reads the engine's
 *   collection but maintains nothing.
 * - A record with `value: undefined` deletes the row (evict and remove look
 *   the same, spec §2).
 *
 * COST. One worktree record touches its own slot, at most one repo slot, and
 * the repo's own lane list — O(lanes of the repo), never the corpus. M3's
 * probe still shows O(1) upkeep for a new issue/session.
 */

import type { EntityName } from './schema'

/** A stored row: the borrowed object the feed handed out, untouched. */
export type LaneStoredRow = object

type LaneLike = { readonly path?: unknown; readonly repoId?: unknown }

/** Whether a `worktree` record value is a lane (vs the raw replicated row). */
export function isLaneRow(row: LaneStoredRow): boolean {
  return typeof (row as LaneLike).path === 'string'
}

/** The repo whose facts a lane carries, or null. */
export function laneRepoId(row: LaneStoredRow): string | null {
  const repoId = (row as LaneLike).repoId
  return typeof repoId === 'string' && repoId.length > 0 ? repoId : null
}

/**
 * Where a feed row spells a schema field differently. Only the repo: its row
 * is a lane, which carries the repo's path as `repoPath`.
 */
const REPO_FEED_SPELLING: Readonly<Record<string, string>> = { path: 'repoPath' }

/** The feed spelling, by entity: the field layers of both arms read through this. */
export const FEED_SPELLING: Readonly<
  Partial<Record<EntityName, Readonly<Record<string, string>>>>
> = { repo: REPO_FEED_SPELLING }

/** Read a repo field off the row the feed handed out (a lane, or the raw row). */
export function repoFieldOf(row: LaneStoredRow, field: string): unknown {
  return (row as Readonly<Record<string, unknown>>)[REPO_FEED_SPELLING[field] ?? field]
}

/**
 * Test-only consumption pin (POD-4695 addendum 2): incremented once per
 * `ingestWorktreeRecord` call, so the guard test can assert that every
 * worktree record an arm ingests passed through this composer. A renamed
 * local copy produces the same table contents but never touches this
 * counter, which is what tells delegation apart from duplication.
 * Production code never reads it; reset it with `resetRepoLaneCalls()`.
 */
export const repoLaneCalls = { worktreeRecords: 0 }

/** Reset the consumption pin before a scripted sequence. */
export function resetRepoLaneCalls(): void {
  repoLaneCalls.worktreeRecords = 0
}

/**
 * What the composition needs from a pool. The two arms' put/drop count
 * differently (MobX slot writes, hand deltas), so the arms pass their own
 * slot writes as closures and this module owns only the routing.
 */
export interface RepoLaneOps {
  getWorktree(id: string): LaneStoredRow | undefined
  getRepo(id: string): LaneStoredRow | undefined
  putWorktree(id: string, row: LaneStoredRow): void
  putRepo(id: string, row: LaneStoredRow): void
  dropWorktree(id: string): void
  dropRepo(id: string): void
  /**
   * The maintained `repo.worktrees` members, or undefined on a target that
   * keeps no relations (a replace staging table). The MobX pool drops the
   * repo then; the hand pool throws (its staging never hands a repo over, so
   * reaching here without relations is a programming error): pass
   * `requireRelations: true` for the throwing policy.
   */
  repoWorktreeMembers(repoId: string): Iterable<string> | undefined
  requireRelations?: boolean
}

/**
 * The repo stops being held by `lane` (it moved or left): another of its
 * lanes takes over, or, with none left (or no relations to ask), it leaves.
 */
function releaseRepoRow(ops: RepoLaneOps, lane: LaneStoredRow): void {
  const repoId = laneRepoId(lane)
  if (repoId === null) return
  // Held by this lane's path: the row may be an earlier object of the same
  // lane, kept while the repo's facts were equal.
  const held = ops.getRepo(repoId)
  if (held === undefined || !isLaneRow(held) || (held as LaneLike).path !== (lane as LaneLike).path)
    return
  const members = ops.repoWorktreeMembers(repoId)
  if (members === undefined) {
    if (ops.requireRelations === true) {
      throw new Error(`[pool] repo ${repoId} changes lanes on a target that keeps no relations`)
    }
    ops.dropRepo(repoId)
    return
  }
  for (const path of members) {
    const other = ops.getWorktree(path)
    if (other !== undefined && other !== lane) {
      ops.putRepo(repoId, other)
      return
    }
  }
  ops.dropRepo(repoId)
}

/** Route one `worktree` record onto the worktree and repo tables. */
export function ingestWorktreeRecord(
  ops: RepoLaneOps,
  id: string,
  value: LaneStoredRow | undefined,
): void {
  repoLaneCalls.worktreeRecords += 1
  const previous = ops.getWorktree(id)
  if (value === undefined) {
    if (previous !== undefined) {
      ops.dropWorktree(id)
      releaseRepoRow(ops, previous)
      return
    }
    // The raw repo row went away (the feed keys it by repoId).
    const held = ops.getRepo(id)
    if (held !== undefined && !isLaneRow(held)) ops.dropRepo(id)
    return
  }
  if (!isLaneRow(value)) {
    const held = ops.getRepo(id)
    if (held === undefined || !isLaneRow(held)) ops.putRepo(id, value)
    return
  }
  ops.putWorktree(id, value)
  const repoId = laneRepoId(value)
  if (repoId !== null) {
    // POD-5423 (review finding 12): the repo's row stays while the repo's own
    // facts are equal, so a lane-only change (a branch, a scan) wakes no
    // reader of the repo (its prefix and path).
    const held = ops.getRepo(repoId)
    if (held === undefined || !isLaneRow(held) || !sameRepoFacts(held, value))
      ops.putRepo(repoId, value)
  }
  if (previous !== undefined && previous !== value && laneRepoId(previous) !== repoId)
    releaseRepoRow(ops, previous)
}

/** The repo-level facts a lane carries: what the repo's row answers. */
const REPO_FACTS = ['repoId', 'repoPath', 'repoName', 'prefix'] as const

function sameRepoFacts(a: LaneStoredRow, b: LaneStoredRow): boolean {
  const left = a as Readonly<Record<string, unknown>>
  const right = b as Readonly<Record<string, unknown>>
  return REPO_FACTS.every((field) => left[field] === right[field])
}
