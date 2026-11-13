import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { use, useLayoutEffect } from 'react'

/**
 * The stack's back swipe (edge and iOS 26 content swipe) belongs to the chat
 * page only. On the deck page every left-to-right drag, from the edge too,
 * pages back to the chat, the way X returns from Following to For you.
 */
export function usePageBackSwipe(enabled: boolean) {
  const navigation = use(NavigationContext)
  useLayoutEffect(() => {
    navigation?.setOptions?.({ gestureEnabled: enabled })
  }, [navigation, enabled])
}
