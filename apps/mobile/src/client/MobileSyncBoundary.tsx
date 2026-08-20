import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { BootTroubleScreen } from '../components/BootTroubleScreen'
import { color, font, mono, radius, space } from '../theme/theme'
import { LaunchReadyView, useLaunchSplashStatusSignal } from './launch-ready'
import type { MobileSyncPhase, MobileSyncProgressStore } from './mobile-sync-progress'

function coldLabel(phase: MobileSyncPhase): string {
  switch (phase) {
    case 'saving':
      return 'SAVING WORKSPACE'
    case 'downloading':
      return 'LOADING WORKSPACE'
    case 'failed':
      return 'CANNOT LOAD WORKSPACE'
    default:
      return 'CONNECTING'
  }
}

function warmLabel(phase: MobileSyncPhase): string {
  switch (phase) {
    case 'reconnecting':
      return 'Reconnecting'
    case 'downloading':
      return 'Refreshing workspace'
    case 'saving':
      return 'Applying updates'
    case 'offline':
      return 'Offline — showing saved data'
    default:
      return 'Updating'
  }
}

const count = (value: number): string => value.toLocaleString('en-US')
export const WARM_SYNC_STATUS_DELAY_MS = 400
export const COLD_SYNC_STALL_MS = 30_000

/**
 * Cold starts have no trustworthy content to operate on, so the launch surface
 * intentionally owns input until the first world is durable. Warm catch-up is
 * the opposite: cached content remains interactive and a non-intercepting
 * status capsule explains that fresher data is arriving.
 */
export function MobileSyncBoundary({
  store,
  children,
  onRetry,
  stallAfterMs = COLD_SYNC_STALL_MS,
}: {
  store: MobileSyncProgressStore
  children: ReactNode
  /** Reopens the principal-scoped replica after a terminal or stalled cold sync. */
  onRetry?: (() => void) | undefined
  /** Injected by tests; production leaves the deliberately generous default. */
  stallAfterMs?: number | undefined
}) {
  const sync = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const reportLaunchStatus = useLaunchSplashStatusSignal()
  const warmStatusActive = !sync.blocking && sync.phase !== 'ready'
  const activelySyncing = warmStatusActive && sync.phase !== 'offline'
  const [showWarmStatus, setShowWarmStatus] = useState(false)
  const [coldStalled, setColdStalled] = useState(false)
  const detail =
    sync.rowsSeen === 0
      ? undefined
      : sync.totalRows === null
        ? `${count(sync.rowsSeen)} items received`
        : `${count(sync.rowsSeen)} of ${count(sync.totalRows)} items`
  const progress =
    sync.totalRows !== null && sync.totalRows > 0
      ? Math.min(1, sync.rowsSeen / sync.totalRows)
      : null

  useEffect(() => {
    reportLaunchStatus(sync.blocking ? { label: coldLabel(sync.phase), detail, progress } : null)
  }, [detail, progress, reportLaunchStatus, sync.blocking, sync.phase])
  useEffect(() => () => reportLaunchStatus(null), [reportLaunchStatus])
  useEffect(() => {
    if (!warmStatusActive) {
      setShowWarmStatus(false)
      return
    }
    // Fast resumes should feel instant, not flash chrome. A catch-up long
    // enough to be noticed gets a stable explanation after one short beat.
    const id = setTimeout(() => setShowWarmStatus(true), WARM_SYNC_STATUS_DELAY_MS)
    return () => clearTimeout(id)
  }, [warmStatusActive])
  useEffect(() => {
    if (!sync.blocking || sync.failure !== null || onRetry === undefined) {
      setColdStalled(false)
      return
    }
    // The replica's own bounded retry ladder keeps running. This timer only
    // retires the opaque splash and offers a recovery action if a cold network
    // sync has made no usable world available for an unusually long time.
    const id = setTimeout(() => setColdStalled(true), stallAfterMs)
    return () => clearTimeout(id)
  }, [onRetry, stallAfterMs, sync.blocking, sync.failure])

  if (sync.blocking && onRetry !== undefined && (sync.failure !== null || coldStalled)) {
    return (
      <LaunchReadyView>
        <BootTroubleScreen
          kind={sync.failure === null ? 'stalled' : 'failed'}
          detail={sync.failure}
          onRetry={onRetry}
        />
      </LaunchReadyView>
    )
  }

  // StoreProvider and MobileHubAttach stay mounted outside this boundary, so a
  // cold replica can connect and install while routes remain unmounted. The
  // parent LaunchBoundary consequently retains its one splash and its input
  // shield; no duplicate wordmark is mounted underneath it.
  if (sync.blocking) return null

  return (
    <View style={styles.root} accessibilityState={{ busy: activelySyncing }}>
      <View style={styles.content} testID="sync-content">
        {children}
      </View>

      {/* Mounted before its text changes so repeated polite announcements are
          reliable. The visible capsule is hidden from accessibility below to
          avoid announcing the same transient status twice. */}
      <Text role="status" accessibilityLiveRegion="polite" style={styles.srStatus}>
        {showWarmStatus && warmStatusActive ? `${warmLabel(sync.phase)}.` : ''}
      </Text>

      {warmStatusActive && showWarmStatus ? (
        <View style={styles.statusHost} testID="warm-sync-status-host">
          <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.status}
            testID="warm-sync-status"
          >
            {sync.phase === 'offline' ? null : (
              <ActivityIndicator size="small" color={color.working} />
            )}
            <Text style={styles.statusText}>{warmLabel(sync.phase)}</Text>
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: color.bg,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  srStatus: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
  },
  statusHost: {
    position: 'absolute',
    top: space.sm,
    left: 0,
    right: 0,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  status: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.surfaceHigh,
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.42)',
  },
  statusText: {
    ...mono(600),
    color: color.body,
    fontSize: font.tiny,
  },
})
