// These are Expo Router's own contexts, shared by native tabs and web stacks.
// Import the context leaves so a pool read does not load the navigator barrel.
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { IsFocusedContext } from 'expo-router/build/react-navigation/core/useIsFocused'
import { useCallback, useContext, useSyncExternalStore } from 'react'

/** Navigator focus also includes the parent tab. Root chrome outside a screen
 * stays active; mounted, blurred scenes keep their paint without pool readers. */
export function useProjectionFocus(): boolean {
  const navigation = useContext(NavigationContext)
  const focused = useContext(IsFocusedContext)
  const subscribe = useCallback(
    (wake: () => void) => {
      if (!navigation || focused !== undefined) return () => {}
      const focus = navigation.addListener('focus', wake)
      const blur = navigation.addListener('blur', wake)
      return () => {
        focus()
        blur()
      }
    },
    [navigation, focused],
  )
  const snapshot = useCallback(
    () => focused ?? navigation?.isFocused() ?? true,
    [focused, navigation],
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
