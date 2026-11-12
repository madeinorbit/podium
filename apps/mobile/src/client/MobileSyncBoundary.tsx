import { COLD_SYNC_STALL_MS, watchReplicaBoot } from '@podium/client-core/replica-assembly'
import { startupTiming } from '../lib/startup-timing'

export { COLD_SYNC_STALL_MS } from '@podium/client-core/replica-assembly'

import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { BootTroubleScreen } from '../components/BootTroubleScreen'
import { color } from '../theme/theme'
import {
  LaunchReadyView,
  type LaunchSplashStatus,
  type LaunchSplashStatusSource,
  useLaunchSplashStatus,
} from './launch-ready'
import type {
  MobileSyncPhase,
  MobileSyncProgressStore,
  MobileSyncSnapshot,
} from './mobile-sync-progress'
import { WorkspaceSyncContext } from './workspace-refresh'

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

const count = (value: number): string => value.toLocaleString('en-US')

function coldStatus(sync: MobileSyncSnapshot): LaunchSplashStatus | null {
  if (!sync.blocking) return null
  return {
    label: coldLabel(sync.phase),
    detail:
      sync.rowsSeen === 0
        ? undefined
        : sync.totalRows === null
          ? `${count(sync.rowsSeen)} items received`
          : `${count(sync.rowsSeen)} of ${count(sync.totalRows)} items`,
    progress:
      sync.totalRows !== null && sync.totalRows > 0
        ? Math.min(1, sync.rowsSeen / sync.totalRows)
        : null,
  }
}

/** The cold-start splash's view of the store: one status per published snapshot. */
function coldStatusSource(store: MobileSyncProgressStore): LaunchSplashStatusSource {
  let read: MobileSyncSnapshot | undefined
  let status: LaunchSplashStatus | null = null
  return {
    subscribe: store.subscribe,
    getSnapshot: () => {
      const sync = store.getSnapshot()
      if (sync !== read) {
        read = sync
        status = coldStatus(sync)
      }
      return status
    },
  }
}

/**
 * Cold starts have no trustworthy content to operate on, so the launch surface
 * intentionally owns input until the first world is durable. Warm catch-up is
 * the opposite: cached content remains interactive, with refresh status in
 * the native header subtitle and the list refresh control.
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
  useLaunchSplashStatus(useMemo(() => coldStatusSource(store), [store]))
  const [coldStalled, setColdStalled] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `sync.attempt` re-arms the stall timer for each new attempt
  useEffect(() => {
    setColdStalled(false)
    if (!sync.blocking || sync.failure !== null || onRetry === undefined) {
      return
    }
    // The replica's own bounded retry ladder keeps running. This timer only
    // retires the opaque splash and offers a recovery action if a cold network
    // sync has made no usable world available for an unusually long time.
    return watchReplicaBoot(() => setColdStalled(true), stallAfterMs)
  }, [onRetry, stallAfterMs, sync.blocking, sync.failure, sync.attempt])

  if (sync.blocking && onRetry !== undefined && (sync.failure !== null || coldStalled)) {
    return (
      <LaunchReadyView>
        <BootTroubleScreen
          kind={sync.failure === null ? 'stalled' : 'failed'}
          detail={sync.failure}
          cause={
            sync.error === 'auth'
              ? { kind: 'signed-out' }
              : sync.error === 'format'
                ? { kind: 'sync-invalid' }
                : undefined
          }
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
  startupTiming.mark('sync.boundary-open')

  return (
    <WorkspaceSyncContext value={store.shared}>
      <View style={styles.root} testID="sync-content">
        {children}
      </View>
    </WorkspaceSyncContext>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: color.bg,
  },
})
