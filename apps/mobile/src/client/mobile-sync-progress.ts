import { type SyncProgressSnapshot, SyncProgressStore } from '@podium/client-core/replica-assembly'
import type { Posture, ReplicaEvent } from '@podium/sync/replica'

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
  readonly attempt: number
  readonly phase: MobileSyncPhase
  readonly rowsSeen: number
  readonly totalRows: number | null
  readonly failure: string | null
  readonly error: SyncProgressSnapshot['error']
}

/** Mobile presentation of the shared lifecycle; owns no sync state or policy. */
export class MobileSyncProgressStore {
  private previous: SyncProgressSnapshot | undefined
  private projected: MobileSyncSnapshot | undefined
  constructor(readonly shared = new SyncProgressStore()) {}
  readonly subscribe = (listener: () => void): (() => void) => this.shared.subscribe(listener)
  readonly getSnapshot = (): MobileSyncSnapshot => {
    const snapshot = this.shared.getSnapshot()
    if (snapshot !== this.previous) {
      this.previous = snapshot
      this.projected = {
        blocking: snapshot.blocking,
        attempt: snapshot.attempt,
        phase:
          snapshot.phase === 'error' ? (snapshot.blocking ? 'failed' : 'offline') : snapshot.phase,
        rowsSeen: snapshot.rowsSeen,
        totalRows: snapshot.totalRows,
        failure: snapshot.failure,
        error: snapshot.error,
      }
    }
    return this.projected!
  }
  readonly retry = (): void => this.shared.retry()
  begin(posture: Posture): void {
    this.shared.begin(posture)
  }
  beginAttempt(): void {
    this.shared.beginAttempt()
  }
  noteMeta(totalRows: number | undefined): void {
    this.shared.noteMeta(totalRows)
  }
  noteReceived(rows: number): void {
    this.shared.noteReceived(rows)
  }
  noteSaving(): void {
    this.shared.noteSaving()
  }
  noteBootstrapFrame(frame: Parameters<SyncProgressStore['noteBootstrapFrame']>[0]): void {
    this.shared.noteBootstrapFrame(frame)
  }
  noteEvent(event: ReplicaEvent): void {
    this.shared.noteEvent(event)
  }
}
