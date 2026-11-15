import { Stack, useFocusEffect } from 'expo-router'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { SearchBarCommands } from 'react-native-screens'
import { useLaunchTransitionHold } from '../client/launch-ready'

/** Keep the initial native search tuck under the launch surface. Later tab
 * opens keep UIKit's resting position instead of starting a visible scroll. */
export function useSearchLaunchTransition() {
  const hold = useLaunchTransitionHold()
  const release = useRef<(() => void) | null>(null)
  const [canTuck, setCanTuck] = useState<boolean | null>(null)
  const onReady = useCallback(() => {
    // A later native probe remount must not repeat startup's programmatic scroll.
    setCanTuck(false)
    release.current?.()
    release.current = null
  }, [])
  useFocusEffect(
    useCallback(() => {
      release.current = hold?.() ?? null
      setCanTuck(release.current !== null)
      return () => {
        onReady()
        setCanTuck(null)
      }
    }, [hold, onReady]),
  )
  return { canTuck, onReady }
}

/** UIKit owns the pull threshold and snap beneath the stock large title.
 * Keep the screen's first scroll view mounted and let it own its offset/insets. */
export function ListSearchBar({
  query,
  onQueryChange,
}: {
  query: string
  onQueryChange: (query: string) => void
}) {
  const searchRef = useRef<SearchBarCommands | null>(null)
  // This tracks only the native control's text; the list owns its one query.
  const nativeQuery = useRef<string | undefined>(undefined)
  const restoreQuery = useCallback(() => {
    if (searchRef.current && nativeQuery.current !== query) {
      searchRef.current.setText(query)
      nativeQuery.current = query
    }
  }, [query])
  useLayoutEffect(restoreQuery, [restoreQuery])
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(restoreQuery)
      return () => cancelAnimationFrame(frame)
    }, [restoreQuery]),
  )

  return (
    <Stack.SearchBar
      ref={searchRef}
      placement="stacked"
      hideWhenScrolling
      allowToolbarIntegration={false}
      obscureBackground={false}
      placeholder="Search tasks or ID"
      autoCapitalize="none"
      onChangeText={(event) => {
        nativeQuery.current = event.nativeEvent.text
        onQueryChange(event.nativeEvent.text)
      }}
      onCancelButtonPress={() => {
        nativeQuery.current = ''
        onQueryChange('')
      }}
    />
  )
}
