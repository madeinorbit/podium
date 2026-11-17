import { Popover } from '@base-ui/react/popover'
import {
  catchUpPercent,
  reviewWords,
  type SyncDisplay,
  type SyncSignals,
  syncCondition,
  syncReviewCount,
} from '@podium/client-graph/sync-status'
import { Check, CircleAlert, CirclePause, Wifi, WifiOff } from 'lucide-react'
import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { throughRestarts } from '@/lib/chunk-recovery'
import { SyncProgressStore } from '@/lib/sync-progress'
import { SyncPanel } from './SyncPanel'
import { useStableSync, useSyncSignals } from './use-sync-status'

const HostInfoView = lazy(() =>
  throughRestarts(() => import('@/features/machines/HostMemoryView')).then((module) => ({
    default: module.HostInfoView,
  })),
)

/** A store that never moves, for strips mounted without a replica (tests, other surfaces). */
const IDLE_PROGRESS = new SyncProgressStore()

/**
 * THE SYNC ITEM (POD-6852) — one slot in the status strip for everything sync
 * says: the catch-up that used to push the workspace down from under the top
 * bar, the connection glyph that used to appear twice, and the three top-bar
 * counters. A condition word (after hysteresis) plus a red review count; one
 * panel behind it. Nothing at all while sync is healthy.
 */
export function SyncStatusItem({
  progress = IDLE_PROGRESS,
}: {
  progress?: SyncProgressStore
}): JSX.Element {
  const signals = useSyncSignals(progress)
  const display = useStableSync(syncCondition(signals))
  const review = syncReviewCount(signals)
  const [open, setOpen] = useState(false)
  const [connectionInfo, setConnectionInfo] = useState(false)
  useReviewToasts(signals, () => setOpen(true))

  // A confirmation never hides a review count; the count is the newer news.
  const shown: SyncDisplay = display === 'up-to-date' && review > 0 ? null : display
  const interactive = review > 0 || (shown !== null && shown !== 'up-to-date')
  const percent = catchUpPercent(signals.replica)

  return (
    <span className="sync-status" data-testid="sync-status" data-display={shown ?? 'none'}>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement(shown, signals.queued, review)}
      </span>
      {shown === 'up-to-date' && !interactive && (
        <span className="sync-item" data-tone="done" data-testid="sync-up-to-date">
          <Check size={11} aria-hidden="true" className="sync-check" />
          <span>Up to date</span>
        </span>
      )}
      {interactive && (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger
            className="sync-item"
            data-tone={tone(shown, review)}
            data-testid="sync-item"
            aria-label={`Sync: ${announcement(shown, signals.queued, review)}. Open details`}
          >
            <ConditionLabel shown={shown} queued={signals.queued} percent={percent} />
            {review > 0 &&
              (shown === null || shown === 'up-to-date' ? (
                <span className="sync-review" data-testid="sync-review-words">
                  <CircleAlert size={12} aria-hidden="true" />
                  {reviewWords(review)}
                </span>
              ) : (
                <span className="sync-pill" data-testid="sync-review-pill">
                  {review}
                </span>
              ))}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="top" align="end" sideOffset={7} className="isolate z-50">
              <Popover.Popup className="sync-panel" data-testid="sync-panel">
                <SyncPanel
                  signals={signals}
                  percent={percent}
                  progress={progress}
                  onClose={() => setOpen(false)}
                  onConnectionDetails={() => {
                    setOpen(false)
                    setConnectionInfo(true)
                  }}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
      {/* Retry sits beside the trigger, never inside it: a button in a button is invalid. */}
      {shown === 'paused' && <span className="sync-sub">·</span>}
      {shown === 'paused' && (
        <button
          type="button"
          data-pressable
          className="sync-retry"
          data-testid="sync-retry"
          onClick={() => progress.retry()}
        >
          Retry
        </button>
      )}
      {connectionInfo && (
        <Suspense fallback={null}>
          <HostInfoView initialTab="connection" onClose={() => setConnectionInfo(false)} />
        </Suspense>
      )}
    </span>
  )
}

function ConditionLabel({
  shown,
  queued,
  percent,
}: {
  shown: SyncDisplay
  queued: number
  percent: number | null
}): JSX.Element | null {
  switch (shown) {
    case 'catching-up':
      return (
        <>
          <Ring />
          <span>Syncing</span>
          {percent !== null && (
            <>
              <span
                className="sync-track"
                role="progressbar"
                aria-label="Catch-up progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span style={{ width: `${percent}%` }} />
              </span>
              <span className="sync-pct">{percent}%</span>
            </>
          )}
        </>
      )
    case 'sending':
      return (
        <>
          <Ring />
          <span>{queued > 0 ? `Sending ${queued}` : 'Sending'}</span>
        </>
      )
    case 'offline':
      return (
        <>
          <span className="sync-bad">
            <WifiOff size={12} aria-hidden="true" className="sync-pulse" />
            <span>Offline</span>
          </span>
          {queued > 0 && <span className="sync-sub">· {queued} queued</span>}
        </>
      )
    case 'paused':
      return (
        <span className="sync-warn">
          <CirclePause size={12} aria-hidden="true" />
          <span>Sync paused</span>
        </span>
      )
    case 'slow':
      return (
        <span className="sync-warn">
          <Wifi size={12} aria-hidden="true" />
          <span>Slow connection</span>
        </span>
      )
    default:
      return null
  }
}

function Ring(): JSX.Element {
  return (
    <svg className="sync-ring" viewBox="0 0 10 10" aria-hidden="true">
      <circle
        cx="5"
        cy="5"
        r="3.8"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".25"
        strokeWidth="1.4"
      />
      <path
        d="M5 1.2a3.8 3.8 0 0 1 3.8 3.8"
        fill="none"
        stroke="var(--live)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function tone(shown: SyncDisplay, review: number): string {
  if (shown === 'offline') return 'bad'
  if (shown === 'paused' || shown === 'slow') return 'warn'
  if (review > 0 && (shown === null || shown === 'up-to-date')) return 'bad'
  return 'neutral'
}

/** The words a screen reader hears. Only the condition and the count; never the percent. */
export function announcement(shown: SyncDisplay, queued: number, review: number): string {
  const parts: string[] = []
  if (shown === 'catching-up') parts.push('Syncing')
  else if (shown === 'sending') parts.push('Sending changes')
  else if (shown === 'offline') parts.push(queued > 0 ? `Offline, ${queued} queued` : 'Offline')
  else if (shown === 'paused') parts.push('Sync paused')
  else if (shown === 'slow') parts.push('Slow connection')
  else if (shown === 'up-to-date' && review === 0) parts.push('Up to date')
  if (review > 0) parts.push(reviewWords(review))
  return parts.join(', ')
}

/** Suppress toasts for what was already waiting when the window opened. */
const TOAST_SETTLE_MS = 3000

/**
 * One toast per new review item: a red number at the window's bottom edge is
 * easy to miss, and these are words the user wrote that did not land. Counts,
 * not lists, so a closed panel keeps reading counts alone; a fixed toast id
 * folds a burst into one toast.
 */
function useReviewToasts(signals: SyncSignals, openPanel: () => void): void {
  const mountedAt = useRef(Date.now())
  const last = useRef({ refused: signals.refused, undelivered: signals.undelivered })
  const open = useRef(openPanel)
  open.current = openPanel
  useEffect(() => {
    const before = last.current
    last.current = { refused: signals.refused, undelivered: signals.undelivered }
    if (Date.now() - mountedAt.current < TOAST_SETTLE_MS) return
    const messages = signals.undelivered - before.undelivered
    const changes = signals.refused - before.refused
    if (messages <= 0 && changes <= 0) return
    const title =
      messages > 0 && changes > 0
        ? 'Some messages and changes didn’t go through'
        : messages > 0
          ? messages === 1
            ? 'A message didn’t arrive'
            : `${messages} messages didn’t arrive`
          : changes === 1
            ? 'A change couldn’t be saved'
            : `${changes} changes couldn’t be saved`
    toast.error(title, {
      id: 'sync-review',
      description:
        messages > 0
          ? 'The agent may not have it. Review sends it again or dismisses it.'
          : 'Your words are kept. Review retries, edits or discards it.',
      action: { label: 'Review', onClick: () => open.current() },
    })
  }, [signals.refused, signals.undelivered])
}
