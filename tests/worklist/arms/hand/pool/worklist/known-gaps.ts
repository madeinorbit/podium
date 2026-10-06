/**
 * POD-4584 (Hb3) — counts helper for tests only.
 *
 * POD-4671 fixed: the unscanned-worktree exception (`acceptUnscannedGap` and
 * `HAND_POOL_ALLOWANCES`) is deleted. The R3 union roots seat the orphan, so
 * parity holds with no allowance. What remains is POD-4678's burst family
 * count, which is a reads allowance, not a parity gap.
 */

import type { HandPool } from '../pool'

/**
 * POD-4678: a new explicit member re-lists its issue's `sessions` bucket, so
 * the #10 burst also reads each burst issue's other explicit sessions. The
 * family, counted from the pool BEFORE the step; 0 on every other step.
 */
export function burstFamilyReads(pool: HandPool, burstIssueIds: readonly string[]): number {
  return burstIssueIds.reduce((sum, id) => sum + (pool.worklist.issue(id)?.seatIds.length ?? 0), 0)
}
