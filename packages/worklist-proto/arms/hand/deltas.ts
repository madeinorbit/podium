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
}

export const nullStats: DerivationStats = {
  summaries: () => {},
  aggregates: () => {},
  visibility: () => {},
  index: () => {},
  rows: () => {},
}
