/**
 * WHICH LIVE ISSUE OWNS THIS FOLDER (POD-6155).
 *
 * The repository hands over the few live issues whose worktree could contain
 * the folder (`IssuesRepository.worktreeOwnerCandidates`: one indexed query,
 * in repository order); these functions decide among them with the same
 * membership test and ranking the durable access index always used:
 * `isMemberCwd`, the deepest worktree by `machinePathKey` length, and the first
 * row in repository order (`repo_path`, then `seq`) on a tie.
 */

import { type IssueId, machinePathKey } from '@podium/model'
import { isMemberCwd } from '../../issue-util'
import type { WorktreeOwnerRow } from '../../store/issues'

/** The live issue whose worktree contains `cwd` most specifically; the first
 *  such row in repository order wins a tie. */
export function deepestOwner(rows: readonly WorktreeOwnerRow[], cwd: string): IssueId | null {
  let best: { id: IssueId; length: number } | undefined
  for (const row of rows) {
    if (!isMemberCwd(row.worktreePath, cwd)) continue
    const length = row.worktreePath ? machinePathKey(row.worktreePath).length : 0
    if (!best || length > best.length) best = { id: row.id, length }
  }
  return best?.id ?? null
}

/**
 * Spawn-time attachment [spec:SP-ccb2]: the deepest containing worktree of a
 * non-archived issue. Several issues at that same deepest root are ambiguous
 * and attach nothing. A registered repo MAIN checkout (`repoRoots`, as
 * `machinePathKey`s) is shared workspace, never an issue's own worktree
 * ([spec:SP-595b] #582).
 */
export function soleOwner(
  rows: readonly WorktreeOwnerRow[],
  cwd: string,
  repoRoots: ReadonlySet<string>,
): IssueId | null {
  const owners = rows.filter(
    (row) =>
      !row.archived &&
      row.worktreePath !== null &&
      !repoRoots.has(machinePathKey(row.worktreePath)) &&
      isMemberCwd(row.worktreePath, cwd),
  )
  const deepest = owners.reduce(
    (length, row) => Math.max(length, row.worktreePath ? machinePathKey(row.worktreePath).length : 0),
    0,
  )
  const mostSpecific = owners.filter(
    (row) => row.worktreePath && machinePathKey(row.worktreePath).length === deepest,
  )
  return mostSpecific.length === 1 ? (mostSpecific[0]?.id ?? null) : null
}
