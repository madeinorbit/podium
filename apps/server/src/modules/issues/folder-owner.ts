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

import { type IssueId, type MachineId, machinePathKey } from '@podium/model'
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
 * and attach nothing. A registered repo MAIN checkout is shared workspace,
 * never an issue's own worktree ([spec:SP-595b] #582).
 *
 * With `machineId`, only an issue homed on that machine (or on none) counts,
 * so a path on one machine never joins another machine's task. Main checkouts
 * are `roots.home` (that machine's, as `machinePathKey`s) for an issue homed
 * there and `roots.any` (every machine's) for an issue with no home.
 */
export function soleOwner(
  rows: readonly WorktreeOwnerRow[],
  cwd: string,
  roots: { any: ReadonlySet<string>; home: ReadonlySet<string> },
  machineId?: MachineId,
): IssueId | null {
  const owners = rows.filter((row) => {
    if (row.archived || row.worktreePath === null || !isMemberCwd(row.worktreePath, cwd)) return false
    const home = machineId === undefined ? null : row.machineId
    if (home != null && home !== machineId) return false
    return !(home == null ? roots.any : roots.home).has(machinePathKey(row.worktreePath))
  })
  const deepest = owners.reduce(
    (length, row) => Math.max(length, row.worktreePath ? machinePathKey(row.worktreePath).length : 0),
    0,
  )
  const mostSpecific = owners.filter(
    (row) => row.worktreePath && machinePathKey(row.worktreePath).length === deepest,
  )
  return mostSpecific.length === 1 ? (mostSpecific[0]?.id ?? null) : null
}
