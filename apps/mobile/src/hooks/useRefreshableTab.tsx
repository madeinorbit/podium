import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshControl } from 'react-native'
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
const MIN_SPINNER_MS = 450

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
export function useRefreshableTab(routeName: string) {
  const hub = useHub()
  const connected = useConnected()
  const listRef = useRef<Scrollable | null>(null)
  const [refreshing, setRefreshing] = useState(false)

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

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    if (!connected) hub.connect()
    const done = setTimeout(() => setRefreshing(false), MIN_SPINNER_MS)
    return () => clearTimeout(done)
  }, [connected, hub])

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={color.textDim}
      colors={[color.accent]}
      progressBackgroundColor={color.surface}
    />
  )

  return { listRef, refreshControl }
}
