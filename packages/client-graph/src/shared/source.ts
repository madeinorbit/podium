/** Row and local channels consumed by the worklist pool. */
import type { IssueSessionFactReader } from './issue-session-facts'
import type { FeedDiagnostics } from './feed-diagnostics'
import type { ColdQueries, HeldSummaries } from './cold-index'
import type { LocalsKey, SliceIssue, SliceSession, SliceWorktree, SliceLocals } from './slice-types'

/**
 * The kernel's effective per-row row stream, as the arms see it. Owned by G3
 * (POD-4444); arms must read nothing beyond it — no legacy store, no replica
 * object, no view-model import.
 */
export interface RowSource {
  /** Always-on failure counters, shared with the attached pool. */
  readonly diagnostics?: FeedDiagnostics
  /** Tracked scalar ownership facts, independent of the issue record. */
  readonly issueSessionFact?: IssueSessionFactReader
  /** Current rows of one kind, in stream order. */
  snapshot(kind: RowRecord['kind']): RowRecord[]
  /** Always-resident companion records, when this source owns that channel. */
  companions?(): RowRecord[]
  /** One callback per publication, coalesced: never a transient half-applied list. */
  subscribe(listener: (event: RowSourceEvent) => void): () => void
  /**
   * POD-4567 (Ma3) — one row's current value by id, exactly as `snapshot(kind)`
   * would carry it (the kernel's per-row read, `replica.row`, with that row's
   * overlays in `overlaid` mode); `undefined` when the row is gone. How a pool
   * hydrates a cold row it holds only the id of (schema doc §5). Only the kinds
   * that can be cold. Optional: a source without it cannot back a lazy pool.
   */
  row?(kind: 'issue' | 'session', id: string): RowRecord['value']
  /** Canonical replica exit evidence, addressed and read without loading. */
  exitKind?(kind: RowRecord['kind'], id: string): 'removed' | 'evicted' | undefined
  /**
   * POD-5405 — the residency rule's questions over EVERY row this feed carries
   * (`cold-index.ts`): built on first call from one snapshot per kind, then
   * kept current from this feed's own publications. Declared questions only;
   * never a map. Optional: a source without it cannot back a resident-only
   * attach. `summaries` (POD-5407): declared summary fields its rows must
   * also hold; a call naming fields the index lacks rebuilds it with them.
   */
  cold?(summaries?: HeldSummaries): ColdQueries
  /** A keyed identity read from the local replica, including cold issues. */
  issueIdByRef?(ref: string): string | undefined
  issueIdsByRef?(ref: string): readonly string[]
}

/**
 * POD-4608 (L1e) — the locals as the arms see them: selection and the coarse
 * clock, mirroring {@link RowSource}. Views are functions of the rows and the
 * locals; this is the locals half.
 *
 * `get()` is the value as of the last notification: an arm never sees a local
 * move without being told which one. Its identity changes only when a value
 * does. Each notification names WHICH keys changed, so a tick wakes only
 * clock consumers (`coarseNow`) and a click only selection consumers
 * (`selectedIssueId`, `selectedIssueWasFolded`). Notifications are coalesced
 * like row events: one per drain, carrying the union of the keys that moved,
 * never a key whose value came back to where it was.
 *
 * Implementations: `createLocalsSource` / `fixedLocals` / `settableLocals`
 * (`locals-source.ts`) and the engine-backed `createEngineLocals`
 * (`harness/src/engine-locals.ts`). Each counts its traffic in
 * `LocalsSourceStats` (`stats.ts`).
 */
export interface LocalsSource<T extends SliceLocals = SliceLocals> {
  get(): T
  subscribe(listener: (changed: ReadonlySet<LocalsKey>) => void): () => void
}

/** One row in the kernel's per-row change stream (spec §2). */
export interface RowRecord {
  kind: 'issue' | 'session' | 'worktree' | 'repo' | 'machine' | 'automation' | 'automationRun' | 'messageRecord' | 'pendingInteraction'
  id: string
  /**
   * The row value, or `undefined` when the row left the replica's scope.
   * Evict carries no tombstone: arms delete the row and every index bucket
   * holding it (spec §2, maintenance rule).
   */
  value: SliceIssue | SliceSession | SliceWorktree | Readonly<Record<string, unknown>> | undefined
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

/**
 * POD-4608 — locals traffic, counted by the source (`locals-source.ts`), never
 * by an arm: one shared place, whatever the arm does underneath.
 */
export interface LocalsSourceStats {
  /** Notification passes to subscribers (one per drain that moved a key). */
  notifications: number
  /** Per key: notifications that named it. A tick counts only `coarseNow`. */
  keys: Record<LocalsKey, number>
  /** Drains that had a signal, notifying or not. */
  flushes: number
  reset(): void
}
