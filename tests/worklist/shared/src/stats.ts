/**
 * POD-4442 — measurement interface for the three round-two arms (spec §3,
 * methodology §5.7 "counts first, walls second").
 *
 * Counts are the verdict-carrying half of the comparison: rows committed,
 * computed re-evaluations, index updates and notifications, asserted per
 * scenario in CI on happy-dom. Walls are measured in Chromium by the G4
 * harness (POD-4445) and never here.
 */

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

export type {
  RowRecord,
  RowSourceEvent,
  LocalsSourceStats,
} from '@podium/client-graph/shared/source'
