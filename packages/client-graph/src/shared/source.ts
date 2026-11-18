import type { FeedDiagnostics } from './feed-diagnostics'
/** Row and local channels consumed by the worklist pool. */
import type { IssueSessionFactReader } from './issue-session-facts'
import type { EntityName } from './schema'
import type { LocalsKey, SliceIssue, SliceLocals, SliceSession, SliceWorktree } from './slice-types'

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
   * overlays in `overlaid` mode); `undefined` when the device does not hold it
   * whole. How a pool tells a row the feed is about to publish from one the
   * loader must fetch. Optional: a source without it cannot back a lazy pool.
   */
  row?(kind: 'issue' | 'session', id: string): RowRecord['value']
  /** Canonical replica exit evidence, addressed and read without loading. */
  exitKind?(kind: RowRecord['kind'], id: string): 'removed' | 'evicted' | undefined
  /** A keyed identity read from the local replica. */
  issueIdByRef?(ref: string): string | undefined
  issueIdsByRef?(ref: string): readonly string[]
  /**
   * POD-7087 — the one loader over the device's collections: what a lookup
   * that finds a record absent, or a view, asks for. Late-bound (the root
   * builds it with the device store). Absent, nothing is fetched from the
   * server and every record not on the device reads as not visible.
   */
  loader?(): CollectionLoaderPort | undefined
}

/** One instance of a declared collection (`@podium/model` `records/`), as the loader takes it. */
export interface LoaderInstance {
  readonly collection: string
  readonly args?: Readonly<
    Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>
  >
  readonly part: 'stub' | 'main'
  readonly via?: string
  readonly after?: readonly (string | number | boolean | null)[]
}

/** A marker: the instance is complete; a paged one says how far, and its whole size. */
export interface LoaderMarker {
  readonly range?: { readonly through?: readonly unknown[]; readonly end: boolean }
  readonly total?: number
}

/**
 * The one loader as the pool reads it: `@podium/sync`'s `CollectionLoader`,
 * structurally (POD-7087). Synchronous reads from the device; requests
 * batch for 50 ms and go to the server's one fetch route.
 */
export interface CollectionLoaderPort {
  request(requests: readonly LoaderInstance[], priority?: 'visible' | 'background'): void
  show(spec: LoaderInstance): () => void
  status(spec: LoaderInstance): 'complete' | 'loading' | 'offline'
  readonly online: boolean
  /** The device started empty and its first download has not finished. */
  readonly firstDownload: boolean
  isComplete(spec: LoaderInstance): LoaderMarker | undefined
  wasRefused(spec: LoaderInstance): boolean
  stubOf(entity: string, entityId: string): Readonly<Record<string, unknown>> | undefined
  stubsByParent(parentId: string): readonly string[]
  stubRows(
    entity: string,
  ): readonly { readonly id: string; readonly stub: Readonly<Record<string, unknown>> }[]
  /** The record at a reference (repository and number), by the stubs (POD-7094: a table lookup). */
  stubIdAt?(entity: string, repoId: string, seq: number): string | undefined
  subscribe(listener: (change: 'markers' | 'stubs' | 'connection') => void): () => void
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
  kind: EntityName
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
