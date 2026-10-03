/** Row and local channels consumed by the worklist pool. */
import type { LocalsKey, SliceIssue, SliceLocals, SliceSession, SliceWorktree } from './slice-types'

/**
 * The kernel's effective per-row row stream, as the arms see it. Owned by G3
 * (POD-4444); arms must read nothing beyond it — no legacy store, no replica
 * object, no view-model import.
 */
export interface RowSource {
  /** Current rows of one kind, in stream order. */
  snapshot(kind: RowRecord['kind']): RowRecord[]
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
export interface LocalsSource {
  get(): SliceLocals
  subscribe(listener: (changed: ReadonlySet<LocalsKey>) => void): () => void
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
