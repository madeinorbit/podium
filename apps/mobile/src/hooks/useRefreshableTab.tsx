import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AccessibilityActionEvent,
  Platform,
  RefreshControl,
  type ScrollViewProps,
} from 'react-native'
import { useConnected, useHub } from '../client/hooks'
import { onTabReselect } from '../lib/tab-reselect'
import { color } from '../theme/theme'

/** The scroll methods the tab roots' lists actually expose. */
interface Scrollable {
  scrollToOffset?(o: { offset: number; animated?: boolean }): void
  scrollTo?(o: { y: number; animated?: boolean }): void
  scrollToLocation?(o: {
    sectionIndex: number
    itemIndex: number
    animated?: boolean
    viewOffset?: number
  }): void
}

/** Shortest animation that still reads as a deliberate response to the pull. */
export const MIN_REFRESH_CONFIRMATION_MS = 650

export type RefreshAccessibilityProps = Pick<
  ScrollViewProps,
  'accessibilityActions' | 'onAccessibilityAction'
>

/**
 * Shared refresh semantics for root lists and transcript lists. The socket is
 * the data source: a disconnected pull cancels backoff and connects now; an
 * already-connected pull confirms that the live replica is current.
 *
 * `onPull` is for the screens that ALSO read something the socket doesn't
 * carry — Pulse polls quota and usage over tRPC — so a pull refreshes what is
 * actually on screen rather than only the transport under it.
 */
export function useRefreshableList(onPull?: () => void) {
  const hub = useHub()
  const connected = useConnected()
  const refreshingRef = useRef(false)
  const confirmationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(
    () => () => {
      if (confirmationTimer.current) clearTimeout(confirmationTimer.current)
    },
    [],
  )

  const onRefresh = useCallback(() => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    if (!connected) hub.connect()
    onPull?.()
    confirmationTimer.current = setTimeout(() => {
      refreshingRef.current = false
      setRefreshing(false)
    }, MIN_REFRESH_CONFIRMATION_MS)
  }, [connected, hub, onPull])

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'refresh') onRefresh()
    },
    [onRefresh],
  )
  const refreshAccessibilityProps = useMemo<RefreshAccessibilityProps>(
    () => ({
      accessibilityActions: [{ name: 'refresh', label: 'Refresh list' }],
      onAccessibilityAction,
    }),
    [onAccessibilityAction],
  )

  // RN Web 0.21 renders this as an inert View and drops the two meaningful
  // props. Do not mount that placeholder: PullToRefreshBoundary owns web.
  const refreshControl =
    Platform.OS === 'web' ? undefined : (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={color.textDim}
        colors={[color.accent]}
        progressBackgroundColor={color.surface}
        accessibilityLabel="Refresh list"
      />
    )

  return {
    connected,
    onRefresh,
    refreshing,
    refreshControl,
    refreshAccessibilityProps,
  }
}

/**
 * Wires a tab root's list to the two gestures a phone list is expected to
 * answer [POD-366]: pull-to-refresh, and re-tapping the active tab to jump
 * back to the top. Neither existed — `RefreshControl` appeared nowhere in the
 * app, and the tab bar swallowed a re-tap.
 *
 * On refresh: the lists are fed by a live replica over a socket, so there is
 * no page to re-fetch. What the gesture usefully does is force the transport
 * to retry NOW instead of waiting out its backoff — which is exactly what you
 * want when the header says "reconnecting…". When the socket is already up the
 * data is current by construction, and the control simply confirms that.
 */
export function useRefreshableTab(routeName: string, onPull?: () => void) {
  const refresh = useRefreshableList(onPull)
  const listRef = useRef<Scrollable | null>(null)

  useEffect(
    () =>
      onTabReselect(routeName, () => {
        const list = listRef.current
        if (!list) return
        // SectionList has no scrollToOffset; FlatList/SectionList and plain
        // ScrollViews each expose a different one of these.
        if (list.scrollToOffset) list.scrollToOffset({ offset: 0, animated: true })
        else if (list.scrollTo) list.scrollTo({ y: 0, animated: true })
        else list.scrollToLocation?.({ sectionIndex: 0, itemIndex: 0, animated: true })
      }),
    [routeName],
  )

  return { listRef, ...refresh }
}
