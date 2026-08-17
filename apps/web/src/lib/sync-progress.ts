/**
 * FIRST-SYNC PROGRESS, observed from the assembly's own seams (POD-1249).
 *
 * A cold replica's whole world arrives as chunked `feedBootstrap` frames and
 * installs in one commit at the end; until then the read model is byte-identical
 * to empty, so nothing downstream of the store can show progress. This store
 * counts at the two places the assembly already touches every frame — the relay
 * into `FeedSink`, and the kernel's `bootstrap-installed` event — and exposes a
 * `useSyncExternalStore`-shaped snapshot for the loading screen.
 *
 * It tracks the FIRST sync only. Re-bootstraps behind a live UI (rescope,
 * compaction) go through the same frames but must not resurrect a loading
 * screen over data the user is working with, so `noteBootstrapFrame` is a no-op
 * until `beginFirstSync()` marks this launch as cold, and forever after
 * `noteInstalled` settles the phase at `ready`.
 *
 * Denominators come from the frames' optional `totalRows`/`countsByEntity`
 * stamps. An older server omits them; that means UNKNOWN — the UI falls back to
 * count-up tallies, never a fabricated percentage (the operation-view rule).
 */

export type SyncPhase =
  /** Cold start acknowledged; no bootstrap frame seen yet. */
  | 'connecting'
  /** Bootstrap chunks arriving. */
  | 'downloading'
  /** Last chunk seen; the one-transaction IndexedDB install is in flight. */
  | 'saving'
  /** `bootstrap-installed` fired — the world is durable and rendered. */
  | 'ready'

export interface SyncProgressSnapshot {
  /** True when THIS launch opened a replica with no persisted cursor. */
  readonly firstSync: boolean
  readonly phase: SyncPhase
  /** Rows received so far across all entities. Exact — counted per frame. */
  readonly rowsSeen: number
  /** Whole-world row count from the server's stamp; null = unknown (old server). */
  readonly totalRows: number | null
  /** Rows received so far, by entity name (`issue`, `session`, …). */
  readonly seenByEntity: Readonly<Record<string, number>>
  /** Whole-world per-entity counts from the server's stamp; null = unknown. */
  readonly totalsByEntity: Readonly<Record<string, number>> | null
  /** Epoch ms when the first sync began (store construction). */
  readonly startedAt: number
}

interface BootstrapFrameLike {
  readonly seq: number
  readonly last: boolean
  readonly changes: ReadonlyArray<{ readonly entity: string }>
  readonly totalRows?: number | undefined
  readonly countsByEntity?: Readonly<Record<string, number>> | undefined
}

export class SyncProgressStore {
  private readonly listeners = new Set<() => void>()
  private snapshot: SyncProgressSnapshot = {
    firstSync: false,
    phase: 'connecting',
    rowsSeen: 0,
    totalRows: null,
    seenByEntity: {},
    totalsByEntity: null,
    startedAt: Date.now(),
  }
  /** The walk currently being counted. Frames of one bootstrap share one `seq`;
   *  a different seq is a fresh world (retry after a failed walk) and restarts
   *  the tallies rather than double-counting on top of them. */
  private walkSeq: number | null = null

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): SyncProgressSnapshot => this.snapshot

  /** Called once, right after the kernel reports a cold posture. */
  beginFirstSync(): void {
    if (this.snapshot.firstSync) return
    this.publish({ ...this.snapshot, firstSync: true, startedAt: Date.now() })
  }

  noteBootstrapFrame(frame: BootstrapFrameLike): void {
    if (!this.snapshot.firstSync || this.snapshot.phase === 'ready') return
    let { rowsSeen, seenByEntity } = this.snapshot
    if (this.walkSeq !== frame.seq) {
      this.walkSeq = frame.seq
      rowsSeen = 0
      seenByEntity = {}
    }
    const seen: Record<string, number> = { ...seenByEntity }
    for (const change of frame.changes) {
      seen[change.entity] = (seen[change.entity] ?? 0) + 1
    }
    this.publish({
      ...this.snapshot,
      phase: frame.last ? 'saving' : 'downloading',
      rowsSeen: rowsSeen + frame.changes.length,
      seenByEntity: seen,
      totalRows: frame.totalRows ?? this.snapshot.totalRows,
      totalsByEntity: frame.countsByEntity ?? this.snapshot.totalsByEntity,
    })
  }

  /** The kernel's `bootstrap-installed` — the world is durable. Terminal. */
  noteInstalled(): void {
    if (this.snapshot.phase === 'ready') return
    this.publish({ ...this.snapshot, phase: 'ready' })
  }

  private publish(next: SyncProgressSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
