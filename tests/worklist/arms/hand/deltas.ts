/**
 * POD-4446 — the closed delta union: the only language derived structures
 * speak (methodology §5.2).
 *
 * One publication is one delta batch, ordered by dataflow topology:
 * tables -> indexes -> summaries -> rollups -> visible -> order/groups -> rows,
 * then a single notification pass with de-duplicated keys. Every handler
 * switches over ALL of these kinds with a never-check, so the compiler
 * refuses a derivation that ignores a kind — that exhaustiveness (plus the
 * rebuild oracle) is the hand-rolled substitute for dependency tracking.
 * There are no input lists anywhere in this folder.
 */

export type Delta =
  /** A table row arrived or changed (value present) — tables -> indexes. */
  | { kind: 'IssueChanged'; id: string }
  /** A table row left scope (evict carries no tombstone — spec §2). */
  | { kind: 'IssueRemoved'; id: string }
  | { kind: 'SessionChanged'; id: string }
  | { kind: 'SessionRemoved'; id: string }
  | { kind: 'WorktreeChanged'; id: string }
  | { kind: 'WorktreeRemoved'; id: string }
  /** An issue's member session set changed (join, leave or move). */
  | { kind: 'MembershipChanged'; issueId: string }
  /** A formal parent-child edge moved (missionParentId semantics). */
  | { kind: 'ChildrenChanged'; childId: string; from: string | null; to: string | null }
  /** An issue's discovered-from origin edge moved. */
  | { kind: 'OriginChanged'; id: string }
  /** An issue's own-summary value changed. */
  | { kind: 'SummaryChanged'; id: string }
  /** An issue's subtree aggregate value changed. */
  | { kind: 'RollupChanged'; id: string }
  /** An issue entered or left the visible set (rescue rows included). */
  | { kind: 'VisibilityChanged'; id: string; visible: boolean }
  /** The ranked order array changed (content or position). */
  | { kind: 'OrderChanged' }
  /** One group's lanes changed (open/closed placement). */
  | { kind: 'GroupChanged'; key: string }
  /** The committed SliceRow value for one row changed. */
  | { kind: 'RowChanged'; id: string }
  /** Selection moved (locals, never a row field — spec R-SEL). */
  | { kind: 'SelectionChanged'; previous: string | null; current: string | null }
  /** The coarse clock moved (locals, never Date.now() — spec §5). */
  | { kind: 'ClockChanged'; now: number }

/** Exhaustiveness gate: every delta handler ends its switch with this, so an
 *  unhandled kind is a compile error, not a silently stale screen. */
export function assertNever(delta: never): never {
  throw new Error(`[hand] unhandled delta kind: ${JSON.stringify(delta)}`)
}

/**
 * Honest derivation counters. Every body execution is counted somewhere:
 * own-summary, subtree-aggregate and visibility-predicate executions land in
 * `rollupsDerived`; committed row changes in `rowsDerived`; bucket writes in
 * `indexUpdates`. An undercount fails shape review, so when in doubt count.
 *
 * Element-visits over more than one row (order membership probes, group
 * rebuild scans, batch-cache builds, subtree walks) land in `scan`: they are
 * the growth-slope material (H4 residuals R-H1/R-M1/R-T1), counted separately
 * so the per-event derivation budgets stay comparable cross-arm. The store
 * surfaces cumulative scan totals beside `ArmStats` (which keeps its four
 * shared fields); the M2 count run reports them per scenario.
 */
export interface DerivationStats {
  /** Own-summary body executions. */
  summaries(): void
  /** Subtree-aggregate body executions. */
  aggregates(): void
  /** Visibility-predicate evaluations. */
  visibility(): void
  /** Relation-index bucket writes. */
  index(): void
  /** Rows whose committed value changed. */
  rows(n: number): void
  /** Element-visits in an O(visible)-or-worse walk (slope material). */
  scan(name: ScanName, visits: number): void
}

/** Named multi-row walks. Each is bounded by the structure named, never by
 *  an ad-hoc collection: that bound is what the M2 note judges inherent or
 *  removable per walk. */
export type ScanName =
  /** Order-array position probes while re-ranking moved rows. */
  | 'order-index'
  /** Order-array visits rebuilding group sequence and touched lanes. */
  | 'groups-rebuild'
  /** Session/bucket visits (re)building the rollup batch cache. */
  | 'rollup-batch'
  /** Issue visits walking formal/spin-off subtrees inside a compute. */
  | 'rollup-walk'
  /** Issue visits re-syncing rescue chains and agent hosting. */
  | 'visible-walk'
  /** Root/session visits resolving worktree-prefix ownership. */
  | 'index-resolve'
  /** Group-member visits refreshing rows after a lane change. */
  | 'rows-group'
  /** Order/group visits assembling a snapshot read. */
  | 'order-snapshot'

export const nullStats: DerivationStats = {
  summaries: () => {},
  aggregates: () => {},
  visibility: () => {},
  index: () => {},
  rows: () => {},
  scan: () => {},
}
