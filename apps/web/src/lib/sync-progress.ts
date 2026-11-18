import { SyncProgressStore } from '@podium/client-core/replica-assembly'
import type { ReplicaEvent } from '@podium/sync/replica'

export type { SyncPhase, SyncProgressSnapshot } from '@podium/client-core/replica-assembly'
export { SyncProgressStore } from '@podium/client-core/replica-assembly'

/**
 * Web's mapping from replica events to the loading screen and warm status line.
 *
 * Only `live` moves the phase; a stale or healing posture leaves it where the
 * walk put it, so an offline tab shows no status line. An exhausted bootstrap
 * always reads as a connection failure the user can retry.
 */
export class WebSyncProgressStore extends SyncProgressStore {
  override noteEvent(event: ReplicaEvent): void {
    // POD-7122: the device opens when the load is in memory, not when it is durable.
    if (event.type === 'load-installed') this.noteInstalled()
    else if (event.type === 'bootstrap-installed') this.noteInstalled(event.entityCount)
    else if (event.type === 'heal-progress')
      this.noteCommitted(event.framesCommitted, event.seq, event.targetSeq, event.fromSeq)
    else if (event.type === 'posture' && event.posture === 'live') this.noteReady()
    else if (event.type === 'bootstrap-failed') this.noteError('network', event.error)
  }
}
