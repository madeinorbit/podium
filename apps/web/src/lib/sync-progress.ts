/** Received bytes are decoded NDJSON data bytes, not compressed network bytes.
 * Bootstrap rows become committed only at atomic install; heals certify frames.
 */
export type SyncPhase = 'connecting' | 'downloading' | 'saving' | 'ready' | 'error'
export interface SyncProgressSnapshot {
  readonly firstSync: boolean
  readonly hasInstalled: boolean
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
}
export class SyncProgressStore {
  private readonly listeners = new Set<() => void>()
  private snapshot: SyncProgressSnapshot = {
    firstSync: false,
    hasInstalled: false,
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
    startedAt: Date.now(),
    error: null,
  }
  retry: () => void = () => {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  readonly getSnapshot = (): SyncProgressSnapshot => this.snapshot
  beginFirstSync(): void {
    this.publish({ ...this.snapshot, firstSync: true })
  }
  beginAttempt(): void {
    this.publish({
      ...this.snapshot,
      phase: 'connecting',
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
      startedAt: Date.now(),
      error: null,
    })
  }
  noteMeta(totalRows: number | undefined): void {
    this.publish({ ...this.snapshot, phase: 'downloading', totalRows: totalRows ?? null })
  }
  noteReceived(rows: number, bytes: number): void {
    this.publish({
      ...this.snapshot,
      phase: 'downloading',
      rowsSeen: this.snapshot.rowsSeen + rows,
      bytesSeen: this.snapshot.bytesSeen + bytes,
    })
  }
  noteSaving(): void {
    this.publish({ ...this.snapshot, phase: 'saving' })
  }
  noteCommitted(frames: number, seq: number, target: number | undefined): void {
    this.publish({
      ...this.snapshot,
      framesCommitted: frames,
      committedSeq: seq,
      targetSeq: target ?? null,
    })
  }
  noteInstalled(rows = this.snapshot.rowsSeen): void {
    this.publish({
      ...this.snapshot,
      rowsCommitted: rows,
      hasInstalled: true,
      phase: 'ready',
      error: null,
    })
  }
  noteReady(): void {
    this.publish({ ...this.snapshot, phase: 'ready', error: null })
  }
  noteError(error: NonNullable<SyncProgressSnapshot['error']>): void {
    this.publish({ ...this.snapshot, phase: 'error', error })
  }
  private publish(next: SyncProgressSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
