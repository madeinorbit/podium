import {
  isCatchingUp,
  isPaused,
  reviewWords,
  type SyncSignals,
} from '@podium/client-graph/sync-status'
import { CircleAlert } from 'lucide-react'
import type { JSX } from 'react'
import { MessageNoticeList } from '@/features/chat/MessageNotices'
import { useConnectionHealth } from '@/features/machines/ConnectionIndicator'
import { OutboxRecoveryList } from '@/features/machines/OutboxRecovery'
import type { SyncProgressStore } from '@/lib/sync-progress'
import { SyncConnectionSection } from './SyncConnectionSection'

/**
 * THE SYNC PANEL (POD-6852). Up to four sections in a fixed order — needs
 * review, connection, incoming, outgoing — each present only while it has
 * something to say. Review rows are the existing recovery and notice rows, so
 * their rules hold here unchanged: no row reads its target (POD-316).
 */
export function SyncPanel({
  signals,
  percent,
  progress,
  onClose,
  onConnectionDetails,
}: {
  signals: SyncSignals
  percent: number | null
  progress: SyncProgressStore
  onClose: () => void
  onConnectionDetails: () => void
}): JSX.Element {
  const health = useConnectionHealth()
  const review = signals.refused + signals.undelivered
  const offline = signals.connection === 'down'
  const paused = isPaused(signals.replica)
  const catchingUp = !paused && isCatchingUp(signals.replica)
  const quiet =
    review === 0 && signals.connection === 'ok' && !paused && !catchingUp && signals.queued === 0

  return (
    <div className="sync-panel-body">
      <header className="sync-panel-head">
        <h2>Sync</h2>
        <span>{summary(signals, paused, catchingUp, review)}</span>
      </header>

      {review > 0 && (
        <section className="sync-panel-sec" data-kind="review" aria-label="Needs review">
          <h3 className="sync-panel-lab" data-tone="bad">
            <CircleAlert size={11} aria-hidden="true" />
            Needs review · {review}
          </h3>
          <MessageNoticeList onOpenChat={onClose} />
          <OutboxRecoveryList />
        </section>
      )}

      {signals.connection !== 'ok' && (
        <SyncConnectionSection health={health} onDetails={onConnectionDetails} />
      )}

      {paused && (
        <section className="sync-panel-sec" aria-label="Incoming">
          <h3 className="sync-panel-lab">Incoming</h3>
          <p>
            {pausedCopy(signals.replica.error)} This window shows your cached workspace meanwhile.
          </p>
          <div>
            <button
              type="button"
              data-pressable
              className="sync-panel-btn"
              data-testid="sync-panel-retry"
              onClick={() => progress.retry()}
            >
              Retry now
            </button>
          </div>
        </section>
      )}

      {catchingUp && (
        <section className="sync-panel-sec" aria-label="Incoming">
          <h3 className="sync-panel-lab">Incoming</h3>
          <p>
            Applying what changed while this window was asleep or offline. You can keep working;
            lists update as it finishes.
          </p>
          <div className="sync-panel-bar" data-indeterminate={percent === null || undefined}>
            <span style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
          {percent !== null && <div className="sync-panel-meta">{percent}% applied</div>}
        </section>
      )}

      {signals.queued > 0 && (
        <section className="sync-panel-sec" aria-label="Outgoing">
          <h3 className="sync-panel-lab">
            {offline ? 'Queued' : 'Sending'} · {signals.queued}
          </h3>
          <p>
            {offline
              ? `${changes(signals.queued)} saved on this device. They send in order when Podium reconnects.`
              : `Sending ${changes(signals.queued).toLowerCase()} to the server.`}
          </p>
        </section>
      )}

      {quiet && (
        <section className="sync-panel-sec">
          <p>Everything is up to date.</p>
        </section>
      )}
    </div>
  )
}

function changes(n: number): string {
  return n === 1 ? '1 change' : `${n} changes`
}

function pausedCopy(error: SyncSignals['replica']['error']): string {
  return error === 'format'
    ? 'The update could not be read safely. Retry downloads it again.'
    : 'The connection dropped during a catch-up.'
}

function summary(
  signals: SyncSignals,
  paused: boolean,
  catchingUp: boolean,
  review: number,
): string {
  const parts: string[] = []
  if (signals.connection === 'down') parts.push('Offline')
  else if (paused) parts.push('Paused')
  else if (signals.connection === 'degraded') parts.push('Slow connection')
  else if (catchingUp) parts.push('Catching up')
  else if (signals.queued > 0) parts.push('Sending')
  if (review > 0) parts.push(reviewWords(review))
  return parts.length > 0 ? parts.join(' · ') : 'Up to date'
}
