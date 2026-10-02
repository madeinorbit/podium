import type { Posture, ReplicaEvent } from '@podium/sync/replica'

export const COLD_SYNC_STALL_MS = 30_000
export type SyncPhase =
  | 'connecting'
  | 'reconnecting'
  | 'updating'
  | 'downloading'
  | 'saving'
  | 'ready'
  | 'offline'
  | 'error'
export interface SyncProgressSnapshot {
  readonly firstSync: boolean
  readonly hasInstalled: boolean
  readonly blocking: boolean
  readonly phase: SyncPhase
  readonly attempt: number
  readonly rowsSeen: number
  readonly bytesSeen: number
  readonly rowsCommitted: number
  readonly framesCommitted: number
  readonly committedSeq: number | null
  readonly targetSeq: number | null
  readonly totalRows: number | null
  readonly seenByEntity: Readonly<Record<string, number>>
  readonly totalsByEntity: Readonly<Record<string, number>> | null
  readonly startedAt: number
  readonly error: 'auth' | 'network' | 'format' | null
  readonly failure: string | null
}

/** Counts decoded receipts separately from commits. Entity events never publish. */
export class SyncProgressStore {
  private readonly listeners = new Set<() => void>()
  private started = false
  private walkSeq: number | null = null
  private snapshot: SyncProgressSnapshot
  constructor(private readonly now: () => number = Date.now) {
    this.snapshot = {
      firstSync: false,
      hasInstalled: false,
      blocking: false,
      phase: 'connecting',
      attempt: 0,
      rowsSeen: 0,
      bytesSeen: 0,
      rowsCommitted: 0,
      framesCommitted: 0,
      committedSeq: null,
      targetSeq: null,
      totalRows: null,
      seenByEntity: {},
      totalsByEntity: null,
      startedAt: now(),
      error: null,
      failure: null,
    }
  }
  retry: () => void = () => {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  readonly getSnapshot = (): SyncProgressSnapshot => this.snapshot
  begin(posture: Posture): void {
    if (this.started) return
    this.started = true
    if (posture === 'cold') this.beginFirstSync()
    else this.publish({ phase: posture === 'live' ? 'ready' : 'reconnecting', hasInstalled: true })
  }
  beginFirstSync(): void {
    this.publish({ firstSync: true, blocking: true })
  }
  beginAttempt(): void {
    this.walkSeq = null
    this.publish({
      phase: this.snapshot.blocking || !this.started ? 'connecting' : 'updating',
      attempt: this.snapshot.attempt + 1,
      rowsSeen: 0,
      bytesSeen: 0,
      rowsCommitted: 0,
      framesCommitted: 0,
      committedSeq: null,
      targetSeq: null,
      totalRows: null,
      seenByEntity: {},
      totalsByEntity: null,
      startedAt: this.now(),
      error: null,
      failure: null,
    })
  }
  noteMeta(totalRows: number | undefined): void {
    this.publish({ phase: 'downloading', totalRows: totalRows ?? null })
  }
  noteReceived(rows: number, bytes = 0): void {
    this.publish({
      phase: 'downloading',
      rowsSeen: this.snapshot.rowsSeen + rows,
      bytesSeen: this.snapshot.bytesSeen + bytes,
    })
  }
  noteSaving(): void {
    this.publish({ phase: 'saving' })
  }
  noteCommitted(frames: number, seq: number, target: number | undefined): void {
    this.publish({
      phase: 'saving',
      framesCommitted: frames,
      committedSeq: seq,
      targetSeq: target ?? null,
    })
  }
  noteInstalled(rows = this.snapshot.rowsSeen): void {
    this.publish({
      rowsCommitted: rows,
      hasInstalled: true,
      blocking: false,
      phase: 'ready',
      error: null,
      failure: null,
    })
  }
  noteReady(): void {
    this.publish({
      blocking: false,
      hasInstalled: true,
      phase: 'ready',
      error: null,
      failure: null,
    })
  }
  noteError(error: NonNullable<SyncProgressSnapshot['error']>, failure = error as string): void {
    this.publish({ phase: 'error', error, failure })
  }
  /** Pushed-frame fixtures and demo use the same accounting as HTTP receipts. */
  noteBootstrapFrame(frame: {
    seq: number
    last: boolean
    changes: ReadonlyArray<unknown>
    totalRows?: number
  }): void {
    if (this.walkSeq !== frame.seq) {
      this.walkSeq = frame.seq
      this.publish({ rowsSeen: 0, totalRows: null })
    }
    this.publish({
      phase: frame.last ? 'saving' : 'downloading',
      rowsSeen: this.snapshot.rowsSeen + frame.changes.length,
      totalRows: frame.totalRows ?? this.snapshot.totalRows,
      failure: null,
      error: null,
    })
  }
  noteEvent(event: ReplicaEvent): void {
    if (event.type === 'bootstrap-installed') this.noteInstalled(event.entityCount)
    else if (event.type === 'heal-progress')
      this.noteCommitted(event.framesCommitted, event.seq, event.targetSeq)
    else if (event.type === 'bootstrap-failed') {
      // The terminal event must not overwrite an earlier auth/format cause.
      this.noteError(this.snapshot.error ?? 'network', this.snapshot.failure ?? event.error)
    } else if (event.type === 'posture') {
      // disconnect() also emits posture events; fatal causes survive them.
      if (this.snapshot.error === 'auth' || this.snapshot.error === 'format') return
      if (event.posture === 'live') this.noteReady()
      else if (event.posture === 'stale') this.publish({ phase: 'offline' })
      else if (event.posture === 'healing' || event.posture === 'bootstrapping') {
        this.publish({
          phase: this.snapshot.blocking ? 'connecting' : 'updating',
          error: null,
          failure: null,
        })
      } else if (event.posture === 'cold' && this.snapshot.failure === null) {
        this.publish({ phase: this.snapshot.blocking ? 'connecting' : 'reconnecting' })
      }
    }
  }
  private publish(patch: Partial<SyncProgressSnapshot>): void {
    if (
      Object.entries(patch).every(
        ([key, value]) => this.snapshot[key as keyof SyncProgressSnapshot] === value,
      )
    )
      return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}
