/**
 * POD-4442 — measurement interface for the three round-two arms (spec §3,
 * methodology §5.7 "counts first, walls second").
 *
 * Counts are the verdict-carrying half of the comparison: rows committed,
 * computed re-evaluations, index updates and notifications, asserted per
 * scenario in CI on happy-dom. Walls are measured in Chromium by the G4
 * harness (POD-4445) and never here.
 */

import type { SliceIssue, SliceSession, SliceWorktree } from './slice-types'

/** Per-arm derivation counters, reset per scenario by the harness. */
export interface ArmStats {
  /** Rows whose committed (published to components) value changed. */
  rowsDerived: number
  /** Rollup/aggregate recomputations (subtree progress, attention sums). */
  rollupsDerived: number
  /** Relation-index bucket writes (children, sessions-by-issue, prefix, origin). */
  indexUpdates: number
  /** Notification passes to subscribers (one batch = one pass, not one per row). */
  notifications: number
  reset(): void
}

/** One row in the kernel's per-row change stream (spec §2). */
export interface RowRecord {
  kind: 'issue' | 'session' | 'worktree'
  id: string
  /**
   * The row value, or `undefined` when the row left the replica's scope.
   * Evict carries no tombstone: arms delete the row and every index bucket
   * holding it (spec §2, maintenance rule).
   */
  value: SliceIssue | SliceSession | SliceWorktree | undefined
}

/**
 * One publication from the kernel's effective row stream. `replace` is the
 * full-slice install (bootstrap, principal switch, rescope); `update` is the
 * per-row delta batch. Ordered by the dataflow topology; one event, one
 * notification pass.
 */
export interface RowSourceEvent {
  type: 'replace' | 'update'
  rows: RowRecord[]
}
