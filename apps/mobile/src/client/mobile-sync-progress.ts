import type { Posture, ReplicaEvent } from '@podium/sync/replica'

/**
 * The operator-facing state of the mobile replica.
 *
 * `blocking` is deliberately independent from `phase`: it is true only until a
 * cursorless launch installs its first durable world. Once that has happened,
 * every later reconnect/re-bootstrap keeps the cached app visible and usable.
 */
export type MobileSyncPhase =
  | 'connecting'
  | 'reconnecting'
  | 'updating'
  | 'downloading'
  | 'saving'
  | 'failed'
  | 'offline'
  | 'ready'

export interface MobileSyncSnapshot {
  readonly blocking: boolean
  readonly phase: MobileSyncPhase
  readonly rowsSeen: number
  readonly totalRows: number | null
  /** Terminal bootstrap detail. Cached warm content remains usable when set. */
  readonly failure: string | null
}

interface BootstrapFrameLike {
  readonly seq: number
  readonly last: boolean
  readonly changes: ReadonlyArray<unknown>
  readonly totalRows?: number | undefined
}

const INITIAL_SNAPSHOT: MobileSyncSnapshot = {
  blocking: false,
  phase: 'ready',
  rowsSeen: 0,
  totalRows: null,
  failure: null,
}

/**
 * A tiny external store at the replica boundary. It observes only lifecycle
 * events, never entity events, so a large world cannot turn progress reporting
 * into another per-row React render path.
 */
export class MobileSyncProgressStore {
  private readonly listeners = new Set<() => void>()
  private snapshot: MobileSyncSnapshot = INITIAL_SNAPSHOT
  private started = false
  private walkSeq: number | null = null

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): MobileSyncSnapshot => this.snapshot

  /** The kernel decides this synchronously from its persisted cursor. */
  begin(posture: Posture): void {
    if (this.started) return
    this.started = true
    this.publish(
      posture === 'cold'
        ? { ...INITIAL_SNAPSHOT, blocking: true, phase: 'connecting' }
        : { ...INITIAL_SNAPSHOT, phase: posture === 'live' ? 'ready' : 'reconnecting' },
    )
  }

  noteBootstrapFrame(frame: BootstrapFrameLike): void {
    let rowsSeen = this.snapshot.rowsSeen
    let totalRows = this.snapshot.totalRows
    if (this.walkSeq !== frame.seq) {
      this.walkSeq = frame.seq
      rowsSeen = 0
      totalRows = null
    }
    this.publish({
      ...this.snapshot,
      phase: frame.last ? 'saving' : 'downloading',
      rowsSeen: rowsSeen + frame.changes.length,
      totalRows: frame.totalRows ?? totalRows,
      failure: null,
    })
  }

  noteEvent(event: ReplicaEvent): void {
    if (event.type === 'bootstrap-installed') {
      this.publish({ ...this.snapshot, blocking: false, phase: 'ready', failure: null })
      return
    }
    if (event.type === 'bootstrap-failed') {
      this.publish({
        ...this.snapshot,
        phase: this.snapshot.blocking ? 'failed' : 'offline',
        failure: event.error,
      })
      return
    }
    if (event.type !== 'posture') return
    this.notePosture(event.posture)
  }

  private notePosture(posture: Posture): void {
    switch (posture) {
      case 'live':
        this.publish({ ...this.snapshot, blocking: false, phase: 'ready', failure: null })
        return
      case 'stale':
        this.publish({
          ...this.snapshot,
          // `stale` is emitted at the transport disconnect boundary. Keep the
          // cached world interactive, but name the fact that new server truth
          // is unavailable instead of implying a connection exists.
          phase: 'offline',
        })
        return
      case 'healing':
        this.publish({ ...this.snapshot, phase: 'updating', failure: null })
        return
      case 'bootstrapping':
        this.publish({
          ...this.snapshot,
          phase: this.snapshot.blocking ? 'connecting' : 'updating',
          failure: null,
        })
        return
      case 'cold':
        this.publish({
          ...this.snapshot,
          phase:
            this.snapshot.failure === null
              ? this.snapshot.blocking
                ? 'connecting'
                : 'reconnecting'
              : this.snapshot.blocking
                ? 'failed'
                : 'offline',
        })
    }
  }

  private publish(next: MobileSyncSnapshot): void {
    if (
      next.blocking === this.snapshot.blocking &&
      next.phase === this.snapshot.phase &&
      next.rowsSeen === this.snapshot.rowsSeen &&
      next.totalRows === this.snapshot.totalRows &&
      next.failure === this.snapshot.failure
    ) {
      return
    }
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
